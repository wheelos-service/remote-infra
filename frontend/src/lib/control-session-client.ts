import { z } from 'zod'
import { organizationHeaders, requestOrganization } from './organization-context'
import {
  base64, controlCommandSchema, controlFeedbackSchema, neutralCommand, signControl,
  type ControlCommand, type ControlFeedback,
} from './control-protocol'

const sessionSchema = z.object({
  session_id: z.string().uuid(),
  vehicle_id: z.string(),
  protocol_version: z.literal(2),
  client_instance_id: z.string(),
  sender_identity: z.string(),
  status: z.literal('ACTIVE'),
})
const responseSchema = z.object({
  session: sessionSchema,
  token: z.string().min(1).optional(),
  renew_after_ms: z.number().int().min(200).max(30_000),
})
export type ControllerState = 'idle' | 'acquiring' | 'connecting' | 'ready' | 'locked' | 'releasing' | 'pending' | 'closed'

export interface ControlConnection {
  connect(token: string): Promise<void>
  publish(body: Uint8Array): Promise<void>
  disconnect(): Promise<void>
}

const SEND_BUDGET_MS = 250
// Replace the former six-sequence distance at the nominal 75 ms cadence with
// an actual dispatch-to-acknowledgement deadline, independent of signing gaps.
const ACK_BUDGET_MS = 450
const MAX_PENDING_COMMANDS = 64
const MAX_TRACE_EVENTS = 128

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
  constructor(readonly status: number, detail = '') {
    super(`Control API: HTTP ${status}${detail ? ` — ${detail}` : ''}`)
  }
}

export class ControlSessionClient {
  state: ControllerState = 'idle'
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
  private timer?: ReturnType<typeof setInterval>
  private sending = false
  private sendStarted = 0
  private renewing = false
  private mediaReady = true
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
  ) {}

  // Bounded, local diagnostics only. Never include credentials, signed bodies,
  // arbitrary transport errors, or command values in this snapshot.
  get diagnostics(): readonly ControlTimingEvent[] {
    return this.trace.map(event => ({ ...event }))
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
          })
          if (allowGone && response.status === 404) return null
          if (!response.ok) {
            let detail = ''
            if (response.status === 409) {
              const reason = (await response.text()).trim()
              if (reason === 'control lease is already held') {
                detail = '控制权已被占用，请先在持有控制权的浏览器中释放，再重试。'
              } else if (reason === 'previous vehicle handover is not confirmed') {
                detail = '上一次车辆交接尚未确认，请等待车端确认；同一操作员的其他车辆会话也可能阻止申请。'
              }
            }
            throw new ControlAPIError(response.status, detail)
          }
          return response.status === 204 ? null : await response.json()
        })(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            reject(new Error('Control API timed out'))
            abort.abort()
          }, 3000)
        }),
      ])
    } finally { clearTimeout(timer) }
  }

  async acquire(): Promise<void> {
    if (this.state !== 'idle') throw new Error('Controller is already in use')
    if (!this.mediaReady) throw new Error('Three camera feeds are not ready')
    this.acquiring = true
    this.error = ''
    this.state = 'acquiring'
    this.changed()
    try {
      const pair = await crypto.subtle.generateKey({ name: 'Ed25519' }, false, ['sign', 'verify']) as CryptoKeyPair
      this.key = pair.privateKey
      const publicKey = base64(new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey)))
      const started = performance.now()
      const response = await this.api(`/api/vehicles/${encodeURIComponent(this.vehicleId)}/control/acquire`, {
        protocol_version: 2, client_instance_id: this.instanceId, public_key_b64: publicKey,
      })
      const data = responseSchema.parse(response)
      this.session = data.session
      if (data.session.vehicle_id !== this.vehicleId ||
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
            timeout = setTimeout(() => reject(new Error('Control RTC connection timed out')), 5000)
          }),
        ])
      } finally { clearTimeout(timeout) }
      if (!this.canContinue()) return
      if (performance.now() >= this.leaseDeadline) throw new Error('Control lease expired while connecting')
      this.connectedAt = performance.now()
      this.timer = setInterval(() => { void this.tick() }, 75)
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Control connection failed'
      // A definitive acquire rejection created no session to release. Keep
      // retries explicit; uncertain failures and safety locks remain latched.
      if (error instanceof ControlAPIError && error.status === 409 &&
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
    if (this.feedback && (data.receiver_instance_id !== this.feedback.receiver_instance_id ||
        data.revision !== this.feedback.revision || data.accepted_sequence < this.feedback.accepted_sequence)) {
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
    this.feedback = data
    this.lastFeedback = performance.now()
    this.record('feedback', data.accepted_sequence)
    if (data.status === 'LOCKED' || data.last_rejection) {
      const reason = data.last_rejection || data.reason
      this.fail(reason, reason === 'stale_command' ? 'stale_command' : 'vehicle_rejection')
    } else if (data.status === 'READY' || data.status === 'APPLIED') this.state = 'ready'
    this.changed()
  }

  setCommand(command: ControlCommand): void {
    if (this.state !== 'ready' || !this.mediaReady) throw new Error('Vehicle control is not ready')
    const next = controlCommandSchema.parse(command)
    if (next.steering === this.command.steering && next.throttle === this.command.throttle &&
        next.brake === this.command.brake && next.direction === this.command.direction) return
    this.command = next
    this.intentRevision++
    this.record('input')
  }

  setMediaReady(ready: boolean): void {
    this.mediaReady = ready
    if (!ready && ['acquiring', 'connecting', 'ready'].includes(this.state)) {
      this.fail('Camera feed lost; release and acquire a new session', 'media_lost')
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
    if (now >= this.leaseDeadline || (this.feedback ? now - this.lastFeedback > 750 : now - this.connectedAt > 5000)) {
      this.fail('Control lease or vehicle feedback timed out', 'authority_or_feedback_timeout')
      return false
    }
    if (this.sending && now - this.sendStarted >= SEND_BUDGET_MS) {
      this.fail('Control signing or publication stalled', 'send_stalled')
      return false
    }
    const oldest = this.pendingCommands[0]
    if (oldest && now - oldest.dispatchedAt >= ACK_BUDGET_MS) {
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
      void this.renew().finally(() => { this.renewing = false })
    }
    if (this.sending || this.state !== 'ready' || !this.feedback || !this.key) return
    this.sending = true
    this.sendStarted = now
    const intentRevision = this.intentRevision
    const sequence = ++this.sequence
    try {
      const body = await signControl(this.key, {
        version: 2, type: 'control', vehicle_id: this.vehicleId,
        session_id: this.session.session_id, client_instance_id: this.instanceId,
        receiver_instance_id: this.feedback.receiver_instance_id, revision: this.feedback.revision,
        sequence, timestamp_ms: Date.now(), command: { ...this.command },
      })
      this.record('sign', sequence, performance.now() - now)
      if (!this.canContinue() || this.state !== 'ready' || !this.checkDeadlines(performance.now())) return
      if (intentRevision !== this.intentRevision) {
        this.record('superseded', sequence)
        return
      }
      if (this.pendingCommands.length >= MAX_PENDING_COMMANDS) {
        this.fail('Too many unacknowledged control commands', 'pending_limit')
        return
      }
      const dispatchedAt = performance.now()
      // Register before calling publish: feedback may arrive before its promise
      // settles. Sequence numbers consumed by discarded signatures stay unique.
      this.pendingCommands.push({ sequence, dispatchedAt })
      this.record('dispatch', sequence, dispatchedAt - now)
      await this.connection.publish(new TextEncoder().encode(body))
      this.record('published', sequence, performance.now() - dispatchedAt)
      if (this.canContinue()) this.checkDeadlines(performance.now())
    } catch {
      this.fail('Control publication failed', 'publication_failed')
    } finally {
      this.sending = false
    }
  }

  private async renew(): Promise<void> {
    const session = this.session
    if (!session) return
    const started = performance.now()
    try {
      const data = responseSchema.parse(await this.api(`/api/control/${session.session_id}/renew`, {}))
      if (data.session.session_id !== session.session_id ||
          data.session.client_instance_id !== this.instanceId ||
          data.session.vehicle_id !== this.vehicleId ||
          data.session.sender_identity !== session.sender_identity) throw new Error('Renew binding mismatch')
      if (performance.now() >= this.leaseDeadline) throw new Error('Lease expired during renewal')
      if (!this.canContinue()) return
      if (performance.now() >= started + data.renew_after_ms * 2) throw new Error('Renewed lease already expired')
      this.leaseDeadline = started + data.renew_after_ms * 2
      this.renewAt = started + data.renew_after_ms
      this.record('renew', this.sequence, performance.now() - started)
    } catch {
      this.fail('Control renewal failed', 'renewal_failed')
    }
  }

  async release(): Promise<void> {
    if (this.state === 'closed') return
    this.closing = true
    this.cleanupError = ''
    if (this.timer) clearInterval(this.timer)
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

  private async finishRelease(): Promise<void> {
    try {
      try {
        await this.connection.disconnect()
      } finally {
        if (this.session) await this.api(`/api/control/${this.session.session_id}/release`, {}, true)
      }
      const session = this.session
      if (!session) return
      this.state = 'pending'
      this.changed()
      const until = performance.now() + 10_000
      while (performance.now() < until) {
        const value = z.object({
          vehicle_id: z.string(), session_id: z.string(), state: z.string(),
          vehicle_handover_confirmed: z.boolean(),
        }).parse(await this.api(`/api/vehicles/${this.vehicleId}/control/handover`))
        if (value.vehicle_id === this.vehicleId && value.session_id === session.session_id &&
            value.state === 'CONFIRMED' && value.vehicle_handover_confirmed === true) {
          this.state = 'closed'
          this.cleanupError = ''
          this.changed()
          return
        }
        await new Promise((resolve) => setTimeout(resolve, 200))
      }
      throw new Error('Simulation handover is still pending')
    } catch (error) {
      this.state = 'pending'
      this.cleanupError = error instanceof ControlAPIError ? error.message :
        error instanceof Error && error.message === 'Simulation handover is still pending' ? error.message :
          'Control release failed; vehicle handover is not confirmed'
      this.record('release_failed')
      this.changed()
      this.releaseTask = undefined
      throw new Error(this.cleanupError)
    }
  }
}
