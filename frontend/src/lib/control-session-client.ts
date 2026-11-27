import { z } from 'zod'
import { CONTROL_TIMING, resolveControlTiming, type ResolvedControlTiming } from './control-timing'
import { controlSafetyDecision } from './control-safety'
import { organizationHeaders, requestOrganization } from './organization-context'
import {
  base64, controlCommandSchema, controlFeedbackSchema, neutralCommand, signControl,
  type ControlCommand, type ControlFeedback, type Gear,
} from './control-protocol'

const sessionSchema = z.object({
  session_id: z.string().uuid(),
  vehicle_id: z.string(),
  protocol_version: z.literal(2),
  client_instance_id: z.string(),
  contract_version: z.literal(3).optional(),
  receiver_instance_id: z.string().regex(/^[a-f0-9]{32}$/).optional(),
  sender_identity: z.string(),
  status: z.literal('ACTIVE'),
})
const timingPolicySchema = z.object({
  control_tick_ms: z.number().int().positive().optional(),
  watchdog_pause_ms: z.number().int().positive().optional(),
  watchdog_lock_ms: z.number().int().positive().optional(),
  rtc_reconnect_grace_ms: z.number().int().positive().optional(),
  media_pause_grace_ms: z.number().int().positive().optional(),
  ack_budget_ms: z.number().int().positive().optional(),
  feedback_timeout_ms: z.number().int().positive().optional(),
  context_ttl_ms: z.number().int().positive().optional(),
}).optional()
const responseSchema = z.object({
  session: sessionSchema,
  token: z.string().min(1).optional(),
  renew_after_ms: z.number().int().min(CONTROL_TIMING.leaseRenewMinMs).max(CONTROL_TIMING.leaseRenewMaxMs),
  server_time_ms: z.number().int().safe().positive().optional(),
  timing_policy: timingPolicySchema,
})
export type ControllerState = 'idle' | 'acquiring' | 'connecting' | 'ready' | 'locked' | 'releasing' | 'pending' | 'closed'

export function isControlReady(state: ControllerState | undefined, mediaReady: boolean): boolean {
  return state === 'ready' && mediaReady
}

export interface ControlConnection {
  connect(token: string): Promise<void>
  publish(body: Uint8Array): Promise<void>
  disconnect(): Promise<void>
}

// Budgets are centralized in control-timing.ts and measure real progress,
// rather than coupling safety deadlines to packet cadence or sequence count.
const MAX_PENDING_COMMANDS = 64
const MAX_TRACE_EVENTS = 128
const CHASSIS_GEAR_MAX_AGE_MS = 500
const chassisGears = new Map<string, Gear | 'P'>([
  ['GEAR_DRIVE', 'D'], ['GEAR_REVERSE', 'R'], ['GEAR_NEUTRAL', 'N'], ['GEAR_PARKING', 'P'],
])

type TraceEvent = 'input' | 'tick' | 'sign' | 'superseded' | 'dispatch' | 'published' |
  'ack' | 'feedback' | 'renew' | 'fault' | 'disconnect_failed' | 'release_failed'
type FaultCode = 'external_fault' | 'invalid_feedback' | 'receiver_changed' | 'unexpected_ack' |
  'vehicle_rejection' | 'stale_command' | 'media_lost' | 'authority_or_feedback_timeout' |
  'send_stalled' | 'ack_timeout' | 'pending_limit' | 'publication_failed' | 'renewal_failed'
export interface ControlTimingEvent {
  event: TraceEvent
  monotonic_ms: number
  sequence: number
  intent_revision: number
  pending_commands: number
  lease_remaining_ms: number
  duration_ms?: number
  wall_elapsed_delta_ms: number
  fault_code?: FaultCode
}

class ControlAPIError extends Error {
  constructor(readonly status: number, detail = '', readonly retryable = false) {
    super(status > 0
      ? `Control API: HTTP ${status}${detail ? ` — ${detail}` : ''}`
      : (detail || 'Control API request failed'))
  }
}

export function steeringAlignedHold(steeringPct?: number): ControlCommand {
  const steering = typeof steeringPct === 'number' && Number.isFinite(steeringPct)
    ? Math.round(Math.max(-100, Math.min(100, -steeringPct))) : 0
  return { steering, throttle: 0, brake: 20, direction: 0 }
}

export class ControlSessionClient {
  state: ControllerState = 'idle'
  private gearCapability = false
  get supportsGearControl(): boolean { return this.gearCapability }
  requestedGear?: Gear
  private chassisGear?: Gear | 'P'
  private gearExpiresAt = 0
  feedback?: ControlFeedback
  error = ''
  cleanupError = ''
  private session?: z.infer<typeof sessionSchema>
  private key?: CryptoKey
  private closing = false
  private acquiring = false
  private renewAt = 0
  private leaseDeadline = 0
  private lastFeedback = 0
  private connectedAt = 0
  private sequence = 0
  private pendingCommands: { sequence: number; dispatchedAt: number }[] = []
  private trace: ControlTimingEvent[] = []
  private readonly traceStarted = performance.now()
  private readonly traceWallStarted = Date.now()
  private lastTick?: number
  private connectionStarted = false
  private command: ControlCommand = { ...neutralCommand }
  private intentRevision = 0
  private publishedIntentRevision = 0
  private publishedIntentCommand?: ControlCommand
  private timer?: ReturnType<typeof setInterval>
  private sending = false
  private sendStarted = 0
  private renewing = false
  private renewTimer?: ReturnType<typeof setTimeout>
  private renewalSeq = 0
  private clockOffsetMs = 0
  private remoteReportedAt?: number
  private steeringPct?: number
  private mediaReady = true
  private rtcReconnecting = false
  private rtcReconnectDeadline = 0
  private timing: ResolvedControlTiming = resolveControlTiming()
  private releaseTask?: Promise<void>
  private readonly instanceId = crypto.randomUUID()
  private readonly organizationId = requestOrganization()

  constructor(
    readonly vehicleId: string,
    private readonly gateway: string,
    private readonly bearer: string,
    private readonly connection: ControlConnection,
    private readonly changed: () => void,
    private readonly request: typeof fetch = (input, init) => fetch(input, init),
    private readonly verifyVideo?: () => boolean,
  ) {}

  // Bounded, local diagnostics only. Never include credentials, signed bodies,
  // arbitrary transport errors, or command values in this snapshot.
  get diagnostics(): readonly ControlTimingEvent[] {
    return this.trace.map(event => ({ ...event }))
  }

  get clockOffset(): number {
    return this.clockOffsetMs
  }

  get timingPolicy(): ResolvedControlTiming {
    return this.timing
  }

  get neutralAcknowledged(): boolean {
    return !this.verifyVideo || (this.feedback?.accepted_sequence ?? 0) > 0
  }

  get actualGear() {
    return performance.now() < this.gearExpiresAt ? this.chassisGear : undefined
  }

  get propulsionDirection(): -1 | 0 | 1 {
    const gear = this.actualGear
    if (!this.supportsGearControl || (this.requestedGear && gear !== this.requestedGear)) return 0
    return gear === 'D' ? 1 : gear === 'R' ? -1 : 0
  }

  private propulsionBlocked(command: ControlCommand): boolean {
    return this.supportsGearControl && command.throttle > 0 &&
      (command.direction === 0 || command.direction !== this.propulsionDirection)
  }

  updateChassisGear(chassis?: { age_ms?: number; source_timestamp_ms?: number; message?: { gear_location?: string } },
      publishedAt?: number): void {
    this.gearExpiresAt = 0
    const source = chassis?.source_timestamp_ms
    const age = chassis?.age_ms
    if (typeof source !== 'number' || typeof age !== 'number' || typeof publishedAt !== 'number') return
    const now = Date.now() + this.clockOffsetMs
    const elapsed = now - publishedAt
    if (elapsed < 0 || age < 0 || source > now) return
    const bound = Math.max(now - source, elapsed + age)
    this.gearExpiresAt = performance.now() + CHASSIS_GEAR_MAX_AGE_MS - bound
    this.chassisGear = chassisGears.get(chassis?.message?.gear_location ?? '')
  }

  get isEmergencyStop(): boolean {
    return !this.command.service_brake && this.command.brake === 100 && this.command.throttle === 0 &&
      this.command.steering === 0 && this.command.direction === 0
  }

  private calibrateClock(serverTimeMs: number | undefined, started: number, finished: number): void {
    const rtt = finished - started
    if (typeof serverTimeMs !== 'number' || !Number.isFinite(rtt) || rtt < 0 || rtt > CONTROL_TIMING.apiTimeoutMs) return
    this.clockOffsetMs = Math.round(serverTimeMs + rtt / 2 - Date.now())
  }

  private record(event: TraceEvent, sequence = this.sequence, duration_ms?: number, fault_code?: FaultCode): void {
    const now = performance.now()
    this.trace.push({ event, monotonic_ms: now, sequence, intent_revision: this.intentRevision,
      pending_commands: this.pendingCommands.length, lease_remaining_ms: Math.max(0, this.leaseDeadline - now),
      duration_ms, fault_code, wall_elapsed_delta_ms: Date.now() - this.traceWallStarted - (now - this.traceStarted) })
    if (this.trace.length > MAX_TRACE_EVENTS) this.trace.shift()
  }

  private async api(path: string, body?: unknown, allowGone = false): Promise<unknown> {
    const abort = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([
        (async () => {
          const response = await this.request(`${this.gateway.replace(/\/$/, '')}${path}`, {
            method: body === undefined ? 'GET' : 'POST',
            headers: { Authorization: `Bearer ${this.bearer}`, ...organizationHeaders(this.organizationId), 'Content-Type': 'application/json' },
            body: body === undefined ? undefined : JSON.stringify(body),
            signal: abort.signal,
            cache: 'no-store',
          }).catch((cause: unknown) => {
            if (cause instanceof TypeError) throw new ControlAPIError(0, 'Control API network unavailable', true)
            throw cause
          })
          if (allowGone && response.status === 404) return null
          if (!response.ok) {
            let detail = ''
            let retryable = response.status === 429 || [500, 502, 503, 504].includes(response.status)
            if ((response.status === 409 || response.status === 503) && typeof response.text === 'function') {
              const reason = (await response.text().catch(() => '')).trim().slice(0, 512)
              if (response.status === 409) {
                if (reason === 'control lease is already held') {
                  detail = '控制权已被占用，请先在持有控制权的浏览器中释放，再重试。'
                } else if (reason === 'previous vehicle handover is not confirmed') {
                  detail = '上一次车辆交接尚未确认，请等待车端确认；同一操作员的其他车辆会话也可能阻止申请。'
                }
              } else if (response.status === 503) {
                if (reason.includes('handover support required')) {
                  detail = '受管实车控制暂未开放（缺少实车交接确认支持）'
                  retryable = false
                } else if (reason.includes('CONTROL_RECEIVER_UNAVAILABLE')) {
                  detail = '车端控制接收器未就绪，请检查车端连接'
                  retryable = false
                } else if (reason.includes('MANAGED_MAINTENANCE_REQUIRED') || reason.includes('maintenance')) {
                  detail = '平台处于维护排空窗口，暂不可申请或续约控制'
                  retryable = false
                } else if (reason) {
                  detail = '网关服务暂时不可用，请稍后重试'
                }
              }
            }
            throw new ControlAPIError(response.status, detail, retryable)
          }
          return response.status === 204 ? null : await response.json()
        })(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            reject(new ControlAPIError(0, 'Control API timed out', true))
            abort.abort()
          }, CONTROL_TIMING.apiTimeoutMs)
        }),
      ])
    } finally { clearTimeout(timer) }
  }

  async acquire(): Promise<void> {
    if (this.state !== 'idle') throw new Error('Controller is already in use')
    if (!this.mediaReady || this.verifyVideo && !this.verifyVideo()) throw new Error('Three camera feeds are not ready')
    this.remoteReportedAt = undefined
    this.steeringPct = undefined
    this.acquiring = true
    this.error = ''
    this.state = 'acquiring'
    this.changed()
    try {
      const pair = await crypto.subtle.generateKey({ name: 'Ed25519' }, false, ['sign', 'verify']) as CryptoKeyPair
      this.key = pair.privateKey
      const publicKey = base64(new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey)))
      let started = 0
      let response: unknown
      for (let attempt = 0; ; attempt++) {
        started = performance.now()
        try {
          response = await this.api(`/api/vehicles/${encodeURIComponent(this.vehicleId)}/control/acquire`, {
            ...(this.verifyVideo ? {contract_version: 3} : {}), protocol_version: 2, client_instance_id: this.instanceId, public_key_b64: publicKey,
          })
          break
        } catch (error) {
          if (!this.canContinue() || !(error instanceof ControlAPIError) ||
              !error.retryable || error.status === 0 || attempt >= 2) {
            throw error
          }
          await new Promise<void>(resolve => setTimeout(resolve, 500 * 2 ** attempt))
          if (!this.canContinue()) return
        }
      }
      const data = responseSchema.parse(response)
      if (data.timing_policy) this.timing = resolveControlTiming(data.timing_policy)
      this.calibrateClock(data.server_time_ms, started, performance.now())
      this.session = data.session
      if (this.verifyVideo && (data.session.contract_version !== 3 || !data.session.receiver_instance_id) ||
          data.session.vehicle_id !== this.vehicleId ||
          data.session.client_instance_id !== this.instanceId ||
          data.session.sender_identity !== `control-${data.session.session_id}` || !data.token) {
        throw new Error('Control session binding mismatch')
      }
      this.leaseDeadline = started + data.renew_after_ms * 2
      this.renewAt = started + data.renew_after_ms
      if (!this.canContinue()) return
      if (performance.now() >= this.leaseDeadline) throw new Error('Control lease expired during acquisition')
      this.state = 'connecting'
      this.changed()
      let timeout: ReturnType<typeof setTimeout> | undefined
      try {
        this.connectionStarted = true
        this.connectedAt = performance.now()
        await Promise.race([
          this.connection.connect(data.token).then(async () => {
            if (this.closing || this.state === 'locked') await this.connection.disconnect()
          }),
          new Promise<never>((_, reject) => {
            timeout = setTimeout(() => reject(new Error('Control RTC connection timed out')), CONTROL_TIMING.rtcConnectTimeoutMs)
          }),
        ])
      } finally { clearTimeout(timeout) }
      if (!this.canContinue()) return
      if (performance.now() >= this.leaseDeadline) throw new Error('Control lease expired while connecting')
      this.connectedAt = performance.now()
      this.timer = setInterval(() => { void this.tick() }, this.timing.tickMs)
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Control connection failed'
      // Explicit HTTP rejections (400/403/409/503) before any session exists
      // created nothing to release; return to idle so the operator can retry
      // without waiting on a phantom handover. Uncertain timeouts (status=0)
      // and safety locks remain latched.
      if (error instanceof ControlAPIError && error.status > 0 &&
          !this.session && !this.closing && this.state === 'acquiring') {
        this.error = message
        this.state = 'idle'
        this.changed()
      } else {
        this.fail(message)
      }
      throw error
    } finally {
      this.acquiring = false
      if (this.closing) {
        await this.connection.disconnect()
        if (this.session) await this.releaseSession()
        else {
          this.state = 'closed'
          this.changed()
        }
      }
    }
  }

  acceptFeedback(sender: string, reliable: boolean, body: Uint8Array): void {
    if (this.closing || this.state === 'locked' || !this.session || sender !== `vehicle-${this.vehicleId}` || !reliable || body.length > 4096) return
    let data: ControlFeedback
    try {
      data = controlFeedbackSchema.parse(JSON.parse(new TextDecoder().decode(body)))
    } catch {
      this.fail('Invalid vehicle control feedback', 'invalid_feedback')
      return
    }
    if (data.session_id !== this.session.session_id || data.vehicle_id !== this.vehicleId) return
    if (this.session.receiver_instance_id ? data.receiver_instance_id !== this.session.receiver_instance_id || data.simulation === true :
        data.simulation === undefined) {
      this.fail('Incompatible vehicle feedback', 'invalid_feedback')
      return
    }
    if (this.feedback && (data.receiver_instance_id !== this.feedback.receiver_instance_id ||
        data.revision !== this.feedback.revision || data.simulation !== this.feedback.simulation || data.accepted_sequence < this.feedback.accepted_sequence)) {
      this.fail('Receiver changed; release and acquire a new session', 'receiver_changed')
      return
    }
    const previous = this.feedback?.accepted_sequence ?? 0
    const acknowledged = this.pendingCommands.find(command => command.sequence === data.accepted_sequence)
    if (data.accepted_sequence !== previous && !acknowledged) {
      this.fail('Unexpected control acknowledgement', 'unexpected_ack')
      return
    }
    // Check before consuming the ACK: a delayed callback must not revive a
    // command whose progress deadline elapsed before the interval callback ran.
    if (!this.checkDeadlines(performance.now())) return
    if (acknowledged) {
      this.record('ack', acknowledged.sequence, performance.now() - acknowledged.dispatchedAt)
      this.pendingCommands = this.pendingCommands.filter(command => command.sequence > data.accepted_sequence)
    }
    if (data.status === 'READY' && data.reason === 'awaiting_command_gear_v1') this.gearCapability = true
    this.feedback = data
    this.lastFeedback = performance.now()
    this.record('feedback', data.accepted_sequence)
    if (data.status === 'LOCKED' || data.last_rejection) {
      const reason = data.last_rejection || data.reason
      this.fail(reason, reason === 'stale_command' ? 'stale_command' : 'vehicle_rejection')
    } else if (data.status === 'READY' || data.status === 'ACCEPTED' || data.status === 'APPLIED' || data.status === 'PAUSED') {
      this.state = 'ready'
    }
    this.changed()
  }

  setRtcReconnecting(reconnecting: boolean): void {
    if (this.closing || this.state === 'closed' || this.state === 'locked') return
    const now = performance.now()
    if (reconnecting) {
      if (!this.rtcReconnecting) {
        this.rtcReconnecting = true
        this.rtcReconnectDeadline = now + this.timing.rtcReconnectGraceMs
      }
      return
    }
    if (!this.rtcReconnecting || !this.checkDeadlines(now)) return
    this.rtcReconnecting = false
    this.rtcReconnectDeadline = 0
    for (const pending of this.pendingCommands) pending.dispatchedAt = now
    this.lastFeedback = now
    if (this.state === 'ready' && !this.isEmergencyStop) {
      this.command = { ...neutralCommand }
      this.intentRevision++
      this.record('input')
    }
  }

  private videoHoldRevision = -1

  updateArbitration(state?: string, drivingMode?: string, steeringPct?: number): void {
    this.steeringPct = steeringPct
    if ((drivingMode != null && drivingMode !== 'COMPLETE_REMOTE_DRIVE') ||
        (state != null && state !== 'REMOTE')) {
      this.remoteReportedAt = undefined
    } else if (state === 'REMOTE') {
      this.remoteReportedAt = performance.now()
    }
  }

  get remoteControlActive(): boolean {
    return this.remoteReportedAt !== undefined && performance.now() - this.remoteReportedAt < this.timing.feedbackTimeoutMs
  }

  get handheldReady(): boolean {
    return this.state === 'ready' && this.mediaReady && this.neutralAcknowledged && this.remoteControlActive &&
      !this.rtcReconnecting && !this.closing && !this.isEmergencyStop
  }

  selectVideoPauseCommand() {
    if (this.isEmergencyStop) return { outcome: 'emergency_stop', command: { ...this.command } } as const
    if (this.neutralAcknowledged && this.remoteControlActive) {
      const command = steeringAlignedHold(this.steeringPct)
      this.setCommand(command)
      this.videoHoldRevision = this.intentRevision
      return { outcome: 'remote_brake_20', command } as const
    }
    this.setCommand(neutralCommand)
    return { outcome: 'standby', command: { ...neutralCommand } } as const
  }

  setCommand(command: ControlCommand): void {
    if (this.state !== 'ready' || !this.mediaReady) throw new Error('Vehicle control is not ready')
    this.videoHoldRevision = -1
    const next = controlCommandSchema.parse(command)
    if ((next.gear_request || next.service_brake) && !this.supportsGearControl) throw new Error('车端未开放手柄挡位与行车制动')
    const neutral = !next.gear_request && !next.service_brake && next.steering === 0 && next.throttle === 0 && next.direction === 0
    if (!this.neutralAcknowledged && !(neutral && (next.brake === 0 || next.brake === 100))) {
      throw new Error('Waiting for signed standby acknowledgement')
    }
    if (next.gear_request) this.requestedGear = next.gear_request
    if (next.gear_request === this.command.gear_request && next.service_brake === this.command.service_brake &&
        next.steering === this.command.steering && next.throttle === this.command.throttle &&
        next.brake === this.command.brake && next.direction === this.command.direction) return
    this.command = next
    this.intentRevision++
    this.record('input')
  }

  setMediaReady(ready: boolean): void {
    this.mediaReady = ready
    if (!ready && ['acquiring', 'connecting', 'ready'].includes(this.state)) {
      this.fail(controlSafetyDecision('media_lost').message, 'media_lost')
    }
  }

  private canContinue(): boolean {
    return !this.closing && this.state !== 'locked' && this.mediaReady
  }

  fail(message: string, code: FaultCode = 'external_fault'): void {
    if (this.closing || this.state === 'closed' || this.state === 'locked') return
    this.command = { ...neutralCommand }
    this.error = message
    this.state = 'locked'
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
    if (this.renewTimer) clearTimeout(this.renewTimer)
    this.renewTimer = undefined
    this.renewing = false
    this.renewalSeq++
    this.record('fault', this.sequence, undefined, code)
    this.changed()
    // Closing the RTC connection stops resume/replay attempts. Receiver fencing
    // and freshness checks remain authoritative for anything already enqueued.
    if (this.connectionStarted) {
      void this.disconnectAfterFault()
    }
  }

  private async disconnectAfterFault(): Promise<void> {
    try { await this.connection.disconnect() } catch {
      if (this.closing || this.state === 'closed') return
      this.cleanupError = 'Control RTC disconnect failed; release is still required'
      this.record('disconnect_failed')
      this.changed()
    }
  }

  private checkDeadlines(now: number): boolean {
    if (now >= this.leaseDeadline) {
      this.fail(controlSafetyDecision('feedback_timeout').message, 'authority_or_feedback_timeout')
      return false
    }
    if (this.rtcReconnecting) {
      if (now >= this.rtcReconnectDeadline) {
        this.fail('Control RTC reconnection timed out', 'authority_or_feedback_timeout')
        return false
      }
      return true
    }
    if (this.feedback
      ? now - this.lastFeedback > this.timing.feedbackTimeoutMs
      : now - this.connectedAt > CONTROL_TIMING.initialFeedbackTimeoutMs) {
      this.fail(controlSafetyDecision('feedback_timeout').message, 'authority_or_feedback_timeout')
      return false
    }
    if (this.sending && now - this.sendStarted >= CONTROL_TIMING.sendBudgetMs) {
      this.fail('Control signing or publication stalled', 'send_stalled')
      return false
    }
    const oldest = this.pendingCommands[0]
    if (oldest && now - oldest.dispatchedAt >= this.timing.ackBudgetMs) {
      this.fail('Control acknowledgement progress timed out', 'ack_timeout')
      return false
    }
    return true
  }

  async tick(): Promise<void> {
    if (this.closing || this.state === 'locked' || !this.session) return
    const now = performance.now()
    this.record('tick', this.sequence, this.lastTick === undefined ? undefined : now - this.lastTick)
    this.lastTick = now
    if (!this.checkDeadlines(now)) return
    if (!this.renewing && now >= this.renewAt) {
      this.renewing = true
      void this.renew(0, ++this.renewalSeq)
    }
    if (this.rtcReconnecting || this.sending || this.state !== 'ready' || !this.feedback || !this.key) return
    this.sending = true
    this.sendStarted = now
    const intentRevision = this.intentRevision
    const signedCommand = { ...this.command }
    if (this.propulsionBlocked(signedCommand)) {
      signedCommand.throttle = 0
      signedCommand.direction = 0
    }
    const sequence = ++this.sequence
    try {
      const body = await signControl(this.key, {
        version: 2, type: 'control', vehicle_id: this.vehicleId,
        session_id: this.session.session_id, client_instance_id: this.instanceId,
        receiver_instance_id: this.feedback.receiver_instance_id, revision: this.feedback.revision,
        sequence, timestamp_ms: Math.max(1, Math.round(Date.now() + this.clockOffsetMs)), command: signedCommand,
      })
      this.record('sign', sequence, performance.now() - now)
      if (!this.canContinue() || this.state !== 'ready' || !this.checkDeadlines(performance.now()) || this.rtcReconnecting) return
      if (intentRevision !== this.intentRevision || this.propulsionBlocked(signedCommand)) {
        this.record('superseded', sequence)
        return
      }
      if (this.verifyVideo && !this.verifyVideo() && intentRevision !== this.videoHoldRevision && !this.isEmergencyStop &&
          (signedCommand.throttle !== 0 || signedCommand.direction !== 0 || signedCommand.steering !== 0 || signedCommand.brake !== 0)) {
        // An expired frame cannot authorize a pending signature. The edge watchdog takes over.
        this.fail('Generated camera freshness expired', 'media_lost')
        return
      }
      if (this.pendingCommands.length >= MAX_PENDING_COMMANDS) {
        this.fail('Too many unacknowledged control commands', 'pending_limit')
        return
      }
      const dispatchedAt = performance.now()
      // Register before calling publish: feedback may arrive before its promise
      // settles. Sequence numbers consumed by discarded signatures stay unique.
      if (signedCommand.gear_request) {
        this.command = { ...neutralCommand }
        this.intentRevision++
      }
      this.pendingCommands.push({ sequence, dispatchedAt })
      this.record('dispatch', sequence, dispatchedAt - now)
      await this.connection.publish(new TextEncoder().encode(body))
      this.publishedIntentRevision = intentRevision
      this.publishedIntentCommand = signedCommand
      this.record('published', sequence, performance.now() - dispatchedAt)
      if (this.canContinue()) this.checkDeadlines(performance.now())
    } catch {
      this.fail('Control publication failed', 'publication_failed')
    } finally {
      this.sending = false
    }
  }

  async neutralizeAndPublish(timeoutMs = CONTROL_TIMING.neutralizeBudgetMs): Promise<void> {
    if (!isControlReady(this.state, this.mediaReady)) return
    const emergency = this.isEmergencyStop
    const safeCommand = emergency ? { ...this.command } : { ...neutralCommand }
    this.setCommand(safeCommand)
    const targetRevision = this.intentRevision
    const deadline = performance.now() + timeoutMs
    while (performance.now() < deadline && this.canContinue()) {
      await this.tick()
      const published = this.publishedIntentCommand
      if (this.publishedIntentRevision === targetRevision && published &&
          published.steering === safeCommand.steering && published.throttle === safeCommand.throttle &&
          published.brake === safeCommand.brake && published.direction === safeCommand.direction) return
      await new Promise((resolve) => setTimeout(resolve, CONTROL_TIMING.controlYieldMs))
    }
    this.fail('Safe control publication timed out', 'publication_failed')
    throw new Error('Safe control publication timed out')
  }

  private async renew(attempt = 0, seq = this.renewalSeq): Promise<void> {
    const session = this.session
    if (!session || !this.canContinue() || seq !== this.renewalSeq) {
      this.renewing = false
      return
    }
    const started = performance.now()
    if (started >= this.leaseDeadline) {
      this.renewing = false
      this.fail(controlSafetyDecision('feedback_timeout').message, 'authority_or_feedback_timeout')
      return
    }
    try {
      const data = responseSchema.parse(await this.api(`/api/control/${session.session_id}/renew`, {}))
      if (data.session.session_id !== session.session_id ||
          data.session.client_instance_id !== this.instanceId ||
          data.session.vehicle_id !== this.vehicleId ||
          data.session.sender_identity !== session.sender_identity) throw new Error('Renew binding mismatch')
      if (performance.now() >= this.leaseDeadline) throw new Error('Lease expired during renewal')
      if (!this.canContinue() || seq !== this.renewalSeq) {
        this.renewing = false
        return
      }
      if (performance.now() >= started + data.renew_after_ms * 2) throw new Error('Renewed lease already expired')
      if (data.timing_policy) this.timing = resolveControlTiming(data.timing_policy)
      this.calibrateClock(data.server_time_ms, started, performance.now())
      this.leaseDeadline = started + data.renew_after_ms * 2
      this.renewAt = started + data.renew_after_ms
      this.renewing = false
      this.record('renew', this.sequence, performance.now() - started)
    } catch (error) {
      if (!this.canContinue() || seq !== this.renewalSeq) {
        this.renewing = false
        return
      }
      if (error instanceof ControlAPIError && error.retryable) {
        const delay = Math.min(500 * 2 ** attempt, 2_000)
        if (performance.now() + delay + CONTROL_TIMING.apiTimeoutMs < this.leaseDeadline) {
          this.renewTimer = setTimeout(() => {
            this.renewTimer = undefined
            void this.renew(attempt + 1, seq)
          }, delay)
          return
        }
      }
      this.renewing = false
      this.fail('Control renewal failed', 'renewal_failed')
    }
  }

  async release(): Promise<void> {
    if (this.state === 'closed') return
    this.closing = true
    this.cleanupError = ''
    if (this.timer) clearInterval(this.timer)
    if (this.renewTimer) clearTimeout(this.renewTimer)
    this.renewTimer = undefined
    this.renewing = false
    this.renewalSeq++
    this.command = { ...neutralCommand }
    this.state = 'releasing'
    this.changed()
    // An acquire already in flight is released in acquire's finally block.
    if (!this.session) {
      await this.connection.disconnect()
      if (!this.acquiring) {
        this.state = 'closed'
        this.changed()
      }
      return
    }
    await this.releaseSession()
  }

  private releaseSession(): Promise<void> {
    if (this.releaseTask) return this.releaseTask
    this.releaseTask = this.finishRelease()
    return this.releaseTask
  }

  private async handoverConfirmed(sessionID: string): Promise<boolean> {
    const status = z.object({
      vehicle_id: z.string(), session_id: z.string(), state: z.string(),
      vehicle_handover_confirmed: z.boolean(),
    }).parse(await this.api(`/api/vehicles/${encodeURIComponent(this.vehicleId)}/control/handover`))
    return status.vehicle_id === this.vehicleId && status.session_id === sessionID &&
      status.state === 'CONFIRMED' && status.vehicle_handover_confirmed
  }

  async refreshHandover(): Promise<boolean> {
    if (this.state !== 'pending' || this.releaseTask || !this.session) return false
    if (!await this.handoverConfirmed(this.session.session_id) || this.releaseTask || this.state !== 'pending') return false
    this.state = 'closed'
    this.cleanupError = ''
    this.changed()
    return true
  }

  private async finishRelease(): Promise<void> {
    try {
      let disconnectCleanupError = ''
      let disconnectTimer: ReturnType<typeof setTimeout> | undefined
      try {
        await Promise.race([
          this.connection.disconnect(),
          new Promise<never>((_, reject) => {
            disconnectTimer = setTimeout(() => reject(new Error('Control RTC disconnect timed out')),
              CONTROL_TIMING.rtcDisconnectBudgetMs)
          }),
        ])
      } catch {
        disconnectCleanupError = 'Control RTC disconnect failed; release continues through Gateway'
        this.record('disconnect_failed')
      } finally { clearTimeout(disconnectTimer) }
      if (this.session) await this.api(`/api/control/${this.session.session_id}/release`, {}, true)
      const session = this.session
      if (!session) return
      this.state = 'pending'
      this.changed()
      const until = performance.now() + CONTROL_TIMING.handoverTimeoutMs
      while (performance.now() < until) {
        if (await this.handoverConfirmed(session.session_id)) {
          this.state = 'closed'
          this.cleanupError = disconnectCleanupError
          this.changed()
          return
        }
        await new Promise((resolve) => setTimeout(resolve, CONTROL_TIMING.handoverPollMs))
      }
      throw new Error('Vehicle handover is still pending')
    } catch (error) {
      this.state = 'pending'
      this.cleanupError = error instanceof ControlAPIError ? error.message :
        error instanceof Error && error.message === 'Vehicle handover is still pending' ? error.message :
          'Control release failed; vehicle handover is not confirmed'
      this.record('release_failed')
      this.changed()
      this.releaseTask = undefined
      throw new Error(this.cleanupError)
    }
  }
}
