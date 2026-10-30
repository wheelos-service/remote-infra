import { z } from 'zod'
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

export class SimulationController {
  state: ControllerState = 'idle'
  feedback?: ControlFeedback
  error = ''
  private session?: z.infer<typeof sessionSchema>
  private key?: CryptoKey
  private closing = false
  private acquiring = false
  private renewAt = 0
  private leaseDeadline = 0
  private lastFeedback = 0
  private connectedAt = 0
  private sequence = 0
  private command: ControlCommand = { ...neutralCommand }
  private intentRevision = 0
  private timer?: ReturnType<typeof setInterval>
  private sending = false
  private sendStarted = 0
  private renewing = false
  private releaseTask?: Promise<void>
  private readonly instanceId = crypto.randomUUID()

  constructor(
    readonly vehicleId: string,
    private readonly gateway: string,
    private readonly bearer: string,
    private readonly connection: ControlConnection,
    private readonly changed: () => void,
    private readonly request: typeof fetch = fetch,
  ) {}

  private async api(path: string, body?: unknown, allowGone = false): Promise<unknown> {
    const abort = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([
        (async () => {
          const response = await this.request(`${this.gateway.replace(/\/$/, '')}${path}`, {
            method: body === undefined ? 'GET' : 'POST',
            headers: { Authorization: `Bearer ${this.bearer}`, 'Content-Type': 'application/json' },
            body: body === undefined ? undefined : JSON.stringify(body),
            signal: abort.signal,
            cache: 'no-store',
          })
          if (allowGone && response.status === 404) return null
          if (!response.ok) throw new Error(`Control API: HTTP ${response.status}`)
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
    this.acquiring = true
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
      if (this.closing) return
      this.state = 'connecting'
      this.changed()
      let timeout: ReturnType<typeof setTimeout> | undefined
      try {
        await Promise.race([
          this.connection.connect(data.token).then(async () => {
            if (this.closing || this.state === 'locked') await this.connection.disconnect()
          }),
          new Promise<never>((_, reject) => {
            timeout = setTimeout(() => reject(new Error('Control RTC connection timed out')), 5000)
          }),
        ])
      } finally { clearTimeout(timeout) }
      if (this.closing) return
      if (performance.now() >= this.leaseDeadline) throw new Error('Control lease expired while connecting')
      this.connectedAt = performance.now()
      this.timer = setInterval(() => { void this.tick() }, 75)
    } catch (error) {
      this.fail(error instanceof Error ? error.message : 'Control connection failed')
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
      this.fail('Invalid vehicle control feedback')
      return
    }
    if (data.session_id !== this.session.session_id || data.vehicle_id !== this.vehicleId) return
    if (this.feedback && (data.receiver_instance_id !== this.feedback.receiver_instance_id ||
        data.revision !== this.feedback.revision || data.accepted_sequence < this.feedback.accepted_sequence)) {
      this.fail('Receiver changed; release and acquire a new session')
      return
    }
    if (data.accepted_sequence > this.sequence || this.sequence - data.accepted_sequence > 6) {
      this.fail('Unexpected control acknowledgement')
      return
    }
    this.feedback = data
    this.lastFeedback = performance.now()
    if (data.status === 'LOCKED' || data.last_rejection) this.fail(data.last_rejection || data.reason)
    else if (data.status === 'READY' || data.status === 'APPLIED') this.state = 'ready'
    this.changed()
  }

  setCommand(command: ControlCommand): void {
    if (this.state !== 'ready') throw new Error('Vehicle control is not ready')
    this.command = controlCommandSchema.parse(command)
    this.intentRevision++
  }

  fail(message: string): void {
    this.command = { ...neutralCommand }
    this.error = message
    if (!this.closing) this.state = 'locked'
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
    this.changed()
  }

  async tick(): Promise<void> {
    if (this.closing || this.state === 'locked' || !this.session) return
    const now = performance.now()
    if (now >= this.leaseDeadline || (this.lastFeedback ? now - this.lastFeedback > 750 : now - this.connectedAt > 5000)) {
      this.fail('Control lease or vehicle feedback timed out')
      return
    }
    if (this.sending && now - this.sendStarted >= 250) {
      this.fail('Control signing or publication stalled')
      return
    }
    if (!this.renewing && now >= this.renewAt) {
      this.renewing = true
      void this.renew().finally(() => { this.renewing = false })
    }
    if (this.sending || this.state !== 'ready' || !this.feedback || !this.key) return
    this.sending = true
    this.sendStarted = now
    const intentRevision = this.intentRevision
    try {
      const body = await signControl(this.key, {
        version: 2, type: 'control', vehicle_id: this.vehicleId,
        session_id: this.session.session_id, client_instance_id: this.instanceId,
        receiver_instance_id: this.feedback.receiver_instance_id, revision: this.feedback.revision,
        sequence: ++this.sequence, timestamp_ms: Date.now(), command: { ...this.command },
      })
      if (!this.closing && this.state === 'ready' && intentRevision === this.intentRevision) {
        await this.connection.publish(new TextEncoder().encode(body))
      }
    } catch {
      this.fail('Control publication failed')
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
      this.leaseDeadline = started + data.renew_after_ms * 2
      this.renewAt = started + data.renew_after_ms
    } catch {
      this.fail('Control renewal failed')
    }
  }

  async release(): Promise<void> {
    if (this.state === 'closed') return
    this.closing = true
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
          this.error = ''
          this.changed()
          return
        }
        await new Promise((resolve) => setTimeout(resolve, 200))
      }
      throw new Error('Simulation handover is still pending')
    } catch (error) {
      this.state = 'pending'
      this.error = error instanceof Error ? error.message : 'Control release failed'
      this.changed()
      this.releaseTask = undefined
      throw error
    }
  }
}
