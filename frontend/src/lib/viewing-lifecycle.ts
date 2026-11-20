import {
  acquireViewing, newViewingId, refreshViewingToken, releaseViewing, renewViewing,
  VIEWING_REQUEST_TIMEOUT_MS, ViewingRequestError,
} from './viewing-api'
import type { ViewingAcquire, ViewingLease } from './viewing-api'
import { requestOrganization } from './organization-context'

interface Observer {
  connect(): Promise<void>
  disconnect(): void | Promise<void>
}

interface ObserverEvents {
  current(): boolean
  reconnecting(): void
  reconnected(): void
  disconnected(): void
}

const MEDIA_RECOVERY_MS = 15_000
const MAX_MEDIA_REBUILD_ATTEMPTS = 3
const RENEW_GUARD_MS = 500

interface ViewingOptions {
  vehicleId: string
  bearer: string
  clientInstanceId: string
  createObserver(token: string, events: ObserverEvents): Observer
  onRecovering?(): void
  onConnected(): void
  onError(error: unknown): void
  onCleanupError(): void
}

interface ViewingApi {
  acquire: typeof acquireViewing
  renew: typeof renewViewing
  release: typeof releaseViewing
  refreshToken?: typeof refreshViewingToken
}

export class ViewingLifecycle {
  private stopped = false
  private started = false
  private lease?: ViewingAcquire
  private lastAcceptedLease?: ViewingLease
  private deadlineMs?: number
  private observer?: Observer
  private roomEpoch = 0
  private roomConnected = false
  private recovery?: { deadlineMs: number; timer: ReturnType<typeof setTimeout>; rebuildAttempts: number }
  private rebuildTimer?: ReturnType<typeof setTimeout>
  private renewalTimer?: ReturnType<typeof setTimeout>
  private expiryTimer?: ReturnType<typeof setTimeout>
  private connectionTimer?: ReturnType<typeof setTimeout>
  private cancelConnection?: () => void
  private cleanup?: Promise<void>
  private readonly requestId = newViewingId()
  private readonly organizationId = requestOrganization()
  private readonly api: ViewingApi

  constructor(
    private readonly options: ViewingOptions,
    api?: ViewingApi,
  ) {
    this.api = api ?? {
      acquire: (vehicle, bearer, request, client) => acquireViewing(vehicle, bearer, request, client, this.organizationId),
      renew: (vehicle, session, bearer) => renewViewing(vehicle, session, bearer, this.organizationId),
      release: (vehicle, session, bearer) => releaseViewing(vehicle, session, bearer, this.organizationId),
      refreshToken: (vehicle, session, bearer) => refreshViewingToken(vehicle, session, bearer, this.organizationId),
    }
  }

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
      for (let attempt = 0; ; attempt++) {
        try {
          this.lease = await this.api.acquire(vehicleId, bearer, this.requestId, clientInstanceId)
          break
        } catch (error) {
          if (this.stopped || !this.options.onRecovering ||
              !(error instanceof ViewingRequestError) || !error.retryable ||
              error.status === 0 || attempt >= 2) {
            throw error
          }
          await new Promise<void>(resolve => setTimeout(resolve, 500 * 2 ** attempt))
          if (this.stopped) return
        }
      }
      if (this.stopped) {
        await this.release()
        return
      }
      this.lastAcceptedLease = this.lease
      this.schedule(this.lease)
      await this.connect(this.lease.token)
    } catch (error) {
      this.fail(error)
    }
  }

  private async connect(token: string) {
    const epoch = ++this.roomEpoch
    const current = () => epoch === this.roomEpoch && this.active &&
      (!this.recovery || performance.now() < this.recovery.deadlineMs)
    const observer = this.options.createObserver(token, {
      current,
      reconnecting: () => {
        if (current()) this.beginRecovery()
      },
      reconnected: () => {
        if (current()) this.roomConnected = true
      },
      disconnected: () => {
        if (current()) this.disconnected()
      },
    })
    try {
      this.observer = observer
      const connecting = observer.connect()
      // Some transports complete after cancellation. Only disconnect this attempt's observer.
      void connecting.then(() => {
        if (this.stopped || epoch !== this.roomEpoch) {
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
              MEDIA_RECOVERY_MS,
            )
          }),
          new Promise<void>((resolve) => { this.cancelConnection = resolve }),
        ])
      } finally {
        if (epoch === this.roomEpoch) {
          clearTimeout(this.connectionTimer)
          this.cancelConnection = undefined
        }
      }
      if (epoch !== this.roomEpoch || !this.guardActive() || !current()) return
      this.roomConnected = true
      if (!this.recovery) this.options.onConnected()
    } catch (error) {
      if (epoch === this.roomEpoch) throw error
    }
  }

  private beginRecovery() {
    if (!this.options.onRecovering) {
      this.fail(new Error('视频连接中断；必须重新连接监看和申请控制'))
      return
    }
    this.roomConnected = false
    if (!this.recovery) {
      this.recovery = {
        deadlineMs: performance.now() + MEDIA_RECOVERY_MS,
        timer: setTimeout(() => this.fail(new Error('视频恢复超时，请重新申请监看')), MEDIA_RECOVERY_MS),
        rebuildAttempts: 0,
      }
    }
    this.options.onRecovering()
  }

  private disconnected() {
    // Let an initial connect failure take the normal error path.
    if (!this.roomConnected && !this.recovery && this.cancelConnection) return
    this.beginRecovery()
    if (!this.recovery || this.recovery.rebuildAttempts >= MAX_MEDIA_REBUILD_ATTEMPTS) {
      if (this.recovery) this.fail(new Error('视频重建失败，请重新申请监看'))
      return
    }
    const attempt = ++this.recovery.rebuildAttempts
    const epoch = ++this.roomEpoch
    clearTimeout(this.connectionTimer)
    clearTimeout(this.rebuildTimer)
    this.rebuildTimer = undefined
    this.cancelConnection?.()
    this.cancelConnection = undefined
    const observer = this.observer
    this.observer = undefined
    void this.disconnect(observer)
    const delay = attempt === 1 ? 0 : Math.min(500 * 2 ** (attempt - 2), 2_000)
    if (delay > 0) {
      if (performance.now() + delay >= this.recovery.deadlineMs) {
        this.fail(new Error('视频恢复超时，请重新申请监看'))
        return
      }
      this.rebuildTimer = setTimeout(() => {
        this.rebuildTimer = undefined
        if (epoch !== this.roomEpoch || this.stopped) return
        void this.rebuild(epoch).catch(error => {
          if (!this.stopped) this.fail(error)
        })
      }, delay)
      return
    }
    void this.rebuild(epoch).catch(error => {
      if (!this.stopped) this.fail(error)
    })
  }

  private async refreshTokenWithRetry(epoch: number, retry = 0): Promise<ViewingAcquire | undefined> {
    if (!this.lease || !this.api.refreshToken) throw new Error('无法更新监看凭证')
    if (epoch !== this.roomEpoch || !this.guardActive() ||
      !this.recovery || performance.now() >= this.recovery.deadlineMs) return undefined
    try {
      return await this.api.refreshToken(
        this.options.vehicleId, this.lease.viewing_session_id, this.options.bearer,
      )
    } catch (error) {
      if (epoch !== this.roomEpoch || !this.guardActive() || !this.recovery) return undefined
      if (error instanceof ViewingRequestError && error.retryable) {
        const delay = Math.min(500 * 2 ** retry, 2_000)
        if (performance.now() + delay + VIEWING_REQUEST_TIMEOUT_MS < this.recovery.deadlineMs) {
          await new Promise<void>(resolve => {
            this.rebuildTimer = setTimeout(() => {
              this.rebuildTimer = undefined
              resolve()
            }, delay)
          })
          return this.refreshTokenWithRetry(epoch, retry + 1)
        }
      }
      throw error
    }
  }

  private async rebuild(epoch: number) {
    const response = await this.refreshTokenWithRetry(epoch)
    if (!response || epoch !== this.roomEpoch || !this.guardActive() ||
      !this.recovery || performance.now() >= this.recovery.deadlineMs) return
    await this.connect(response.token)
  }

  frameRendered() {
    if (!this.recovery || !this.roomConnected || !this.guardActive() ||
      performance.now() >= this.recovery.deadlineMs) return
    clearTimeout(this.recovery.timer)
    clearTimeout(this.rebuildTimer)
    this.rebuildTimer = undefined
    this.recovery = undefined
    this.options.onConnected()
  }

  private schedule(lease: ViewingLease) {
    clearTimeout(this.expiryTimer)
    clearTimeout(this.renewalTimer)
    const deadline = lease.deadlineMs - (this.options.onRecovering ? RENEW_GUARD_MS : 0)
    const remaining = deadline - performance.now()
    if (remaining <= 0) throw new Error('监看租约已过期')
    this.deadlineMs = deadline
    this.expiryTimer = setTimeout(() => this.fail(new Error('监看租约已过期，已停止监看')), remaining)
    this.renewalTimer = setTimeout(() => { void this.renew() }, Math.min(lease.renew_after_ms, remaining))
  }

  private async renew(attempt = 0) {
    if (!this.guardActive() || !this.lease) return
    const deadline = this.deadlineMs
    if (this.options.onRecovering && deadline !== undefined &&
      performance.now() + VIEWING_REQUEST_TIMEOUT_MS >= deadline) return
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
      if (!this.guardActive()) return
      if (this.options.onRecovering && error instanceof ViewingRequestError && error.retryable) {
        const delay = Math.min(500 * 2 ** attempt, 2_000)
        if (deadline !== undefined && performance.now() + delay + VIEWING_REQUEST_TIMEOUT_MS < deadline) {
          this.renewalTimer = setTimeout(() => { void this.renew(attempt + 1) }, delay)
        }
        return
      }
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
    clearTimeout(this.rebuildTimer)
    this.rebuildTimer = undefined
    if (this.recovery) clearTimeout(this.recovery.timer)
    this.cancelConnection?.()
    const observer = this.observer
    this.observer = undefined
    // Release must not wait for a stalled transport disconnect.
    this.cleanup = Promise.all([
      this.disconnect(observer),
      this.release(),
    ]).then(() => {})
    return this.cleanup
  }

  private disconnect(observer?: Observer) {
    return Promise.resolve().then(() => observer?.disconnect()).catch(() => this.options.onCleanupError())
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
