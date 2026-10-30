import { acquireViewing, newViewingId, releaseViewing, renewViewing } from './viewing-api'
import type { ViewingAcquire, ViewingLease } from './viewing-api'

interface Observer {
  connect(): Promise<void>
  disconnect(): void | Promise<void>
}

interface ViewingOptions {
  vehicleId: string
  bearer: string
  clientInstanceId: string
  createObserver(token: string): Observer
  onConnected(): void
  onError(error: unknown): void
  onCleanupError(): void
}

interface ViewingApi {
  acquire: typeof acquireViewing
  renew: typeof renewViewing
  release: typeof releaseViewing
}

const defaultApi: ViewingApi = {
  acquire: acquireViewing,
  renew: renewViewing,
  release: releaseViewing,
}

export class ViewingLifecycle {
  private stopped = false
  private started = false
  private lease?: ViewingAcquire
  private lastAcceptedLease?: ViewingLease
  private deadlineMs?: number
  private observer?: Observer
  private renewalTimer?: ReturnType<typeof setTimeout>
  private expiryTimer?: ReturnType<typeof setTimeout>
  private connectionTimer?: ReturnType<typeof setTimeout>
  private cancelConnection?: () => void
  private cleanup?: Promise<void>
  private readonly requestId = newViewingId()

  constructor(
    private readonly options: ViewingOptions,
    private readonly api: ViewingApi = defaultApi,
  ) {}

  get active() {
    return !this.stopped &&
      (this.deadlineMs === undefined || performance.now() < this.deadlineMs)
  }

  private guardActive(): boolean {
    if (this.active) return true
    if (!this.stopped) this.fail(new Error('监看租约已过期，已停止监看'))
    return false
  }

  async start(): Promise<void> {
    if (this.started || this.stopped) return
    this.started = true
    const { vehicleId, bearer, clientInstanceId } = this.options
    try {
      this.lease = await this.api.acquire(vehicleId, bearer, this.requestId, clientInstanceId)
      if (this.stopped) {
        await this.release()
        return
      }
      this.lastAcceptedLease = this.lease
      this.schedule(this.lease)
      const observer = this.options.createObserver(this.lease.token)
      this.observer = observer
      const connecting = observer.connect()
      // Some transports complete after cancellation. Only disconnect this attempt's observer.
      void connecting.then(() => {
        if (this.stopped) {
          void Promise.resolve().then(() => observer.disconnect())
            .catch(() => this.options.onCleanupError())
        }
      }, () => {})
      try {
        await Promise.race([
          connecting,
          new Promise<never>((_, reject) => {
            this.connectionTimer = setTimeout(
              () => reject(new Error('连接 LiveKit 超时，请检查网络后重试')),
              15_000,
            )
          }),
          new Promise<void>((resolve) => { this.cancelConnection = resolve }),
        ])
      } finally {
        clearTimeout(this.connectionTimer)
        this.cancelConnection = undefined
      }
      if (!this.guardActive()) return
      this.options.onConnected()
    } catch (error) {
      this.fail(error)
    }
  }

  private schedule(lease: ViewingLease) {
    clearTimeout(this.expiryTimer)
    clearTimeout(this.renewalTimer)
    const remaining = lease.deadlineMs - performance.now()
    if (remaining <= 0) throw new Error('监看租约已过期')
    this.deadlineMs = lease.deadlineMs
    this.expiryTimer = setTimeout(() => this.fail(new Error('监看租约已过期，已停止监看')), remaining)
    this.renewalTimer = setTimeout(() => { void this.renew() }, Math.min(lease.renew_after_ms, remaining))
  }

  private async renew() {
    if (!this.guardActive() || !this.lease) return
    try {
      const lease = await this.api.renew(
        this.options.vehicleId, this.lease.viewing_session_id, this.options.bearer,
      )
      // The previous deadline stays authoritative until this response is accepted.
      if (!this.guardActive()) return
      const previous = this.lastAcceptedLease
      if (
        !previous ||
        lease.expires_at_ms <= previous.expires_at_ms ||
        lease.server_time_ms < previous.server_time_ms
      ) {
        throw new Error('监看续期响应未推进服务端租约状态')
      }
      this.lastAcceptedLease = lease
      this.schedule(lease)
    } catch (error) {
      this.fail(error)
    }
  }

  fail(error: unknown) {
    if (this.stopped) return
    void this.stop()
    this.options.onError(error)
  }

  stop(): Promise<void> {
    if (this.stopped) return this.cleanup ?? Promise.resolve()
    this.stopped = true
    clearTimeout(this.expiryTimer)
    clearTimeout(this.renewalTimer)
    clearTimeout(this.connectionTimer)
    this.cancelConnection?.()
    const observer = this.observer
    this.observer = undefined
    // Release must not wait for a stalled transport disconnect.
    this.cleanup = Promise.all([
      Promise.resolve().then(() => observer?.disconnect()).catch(() => this.options.onCleanupError()),
      this.release(),
    ]).then(() => {})
    return this.cleanup
  }

  private async release() {
    const lease = this.lease
    this.lease = undefined
    this.lastAcceptedLease = undefined
    if (!lease) return
    try {
      await this.api.release(this.options.vehicleId, lease.viewing_session_id, this.options.bearer)
    } catch {
      this.options.onCleanupError()
    }
  }
}
