import { z } from 'zod'
import { teleopConfig } from './teleop-config'

export const VIEWING_REQUEST_TIMEOUT_MS = 5_000
const gatewayUrl = teleopConfig.gatewayUrl.replace(/\/$/, '')
const timestamp = z.number().int().safe().positive()
const vehicleIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/)
const leaseFields = {
  vehicle_id: vehicleIdSchema,
  viewing_session_id: z.string().uuid(),
  expires_at_ms: timestamp,
  server_time_ms: timestamp,
  renew_after_ms: z.literal(10_000),
}
export const viewingLeaseSchema = z.object(leaseFields).strict()
export const viewingAcquireSchema = z.object({
  ...leaseFields,
  token: z.string().min(1),
}).strict()

export type ViewingLease = z.infer<typeof viewingLeaseSchema> & { deadlineMs: number }
export type ViewingAcquire = ViewingLease & { token: string }

export function newViewingId(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  // getRandomValues also works for the existing HTTP-only layout preview.
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  bytes[6] = (bytes[6] & 0x0f) | 0x40
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

export function isVehicleVideoSender(identity: string, vehicleId: string): boolean {
  return identity === `vehicle-${vehicleId}`
}

async function post(path: string, bearer: string, body?: object, keepalive = false): Promise<unknown> {
  const controller = new AbortController()
  let timeout: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      (async () => {
        const response = await fetch(`${gatewayUrl}${path}`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${bearer}`,
            ...(body ? { 'Content-Type': 'application/json' } : {}),
          },
          body: body ? JSON.stringify(body) : undefined,
          signal: controller.signal,
          cache: 'no-store',
          keepalive,
        })
        if (!response.ok) {
          throw new Error(response.status === 401
            ? '监看认证已失效，请重新登录'
            : `监看租约请求失败 (${response.status})`)
        }
        return response.status === 204 ? undefined : await response.json()
      })(),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => {
          reject(new Error('监看租约请求超时；已停止监看，请重试'))
          controller.abort()
        }, VIEWING_REQUEST_TIMEOUT_MS)
      }),
    ])
  } finally {
    clearTimeout(timeout)
  }
}

function path(vehicleId: string, sessionId?: string): string {
  vehicleIdSchema.parse(vehicleId)
  if (sessionId) z.string().uuid().parse(sessionId)
  return `/api/vehicles/${encodeURIComponent(vehicleId)}/viewing${
    sessionId ? `/${encodeURIComponent(sessionId)}` : ''
  }`
}

function withDeadline<T extends z.infer<typeof viewingLeaseSchema>>(
  lease: T,
  vehicleId: string,
  startedAt: number,
  sessionId?: string,
): T & { deadlineMs: number } {
  const remaining = lease.expires_at_ms - lease.server_time_ms
  if (lease.vehicle_id !== vehicleId ||
      (sessionId !== undefined && lease.viewing_session_id !== sessionId) ||
      remaining <= 0 || remaining > 30_000) {
    throw new Error('监看租约身份或有效期限无效')
  }
  // Starting the deadline at request start subtracts the full HTTP round trip.
  const deadlineMs = startedAt + remaining
  if (deadlineMs <= performance.now()) throw new Error('监看租约已过期')
  return { ...lease, deadlineMs }
}

export async function releaseViewing(vehicleId: string, sessionId: string, bearer: string) {
  await post(`${path(vehicleId, sessionId)}/release`, bearer, undefined, true)
}

export async function acquireViewing(
  vehicleId: string,
  bearer: string,
  requestId: string,
  clientInstanceId: string,
): Promise<ViewingAcquire> {
  const uuidV4 = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i)
  uuidV4.parse(requestId)
  uuidV4.parse(clientInstanceId)
  const startedAt = performance.now()
  const raw = await post(`${path(vehicleId)}/acquire`, bearer, {
    request_id: requestId,
    client_instance_id: clientInstanceId,
  })
  try {
    return withDeadline(viewingAcquireSchema.parse(raw), vehicleId, startedAt)
  } catch {
    // Release even a malformed response when its vehicle/session identity is trustworthy.
    const identity = z.object({
      vehicle_id: z.literal(vehicleId),
      viewing_session_id: z.string().uuid(),
    }).safeParse(raw)
    if (identity.success) {
      await releaseViewing(vehicleId, identity.data.viewing_session_id, bearer).catch(() => {
        console.error('释放无效监看租约失败；租约将在 30 秒 TTL 后失效')
      })
    }
    throw new Error('监看租约响应无效或已过期')
  }
}

export async function renewViewing(
  vehicleId: string,
  sessionId: string,
  bearer: string,
): Promise<ViewingLease> {
  const startedAt = performance.now()
  const raw = await post(`${path(vehicleId, sessionId)}/renew`, bearer)
  try {
    return withDeadline(viewingLeaseSchema.parse(raw), vehicleId, startedAt, sessionId)
  } catch {
    throw new Error('续期响应身份或有效期限无效')
  }
}
