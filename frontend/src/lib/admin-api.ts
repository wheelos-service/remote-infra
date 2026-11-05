import { z } from 'zod'
import { teleopConfig } from './teleop-config'

export const managedRole = z.enum(['org_admin', 'viewer', 'remote_operator'])
export const managedScope = z.enum(['none', 'all', 'selected'])
export const adminContextSchema = z.object({
  mode: z.literal('managed'),
  authorization_version: z.number().int().nonnegative().optional(),
  organizations: z.array(z.object({ org_id: z.string().min(1), name: z.string() })),
  platform_admin: z.boolean(),
  manual_provisioning: z.boolean().default(true),
  onboarding_enabled: z.boolean().default(false),
})
const personSchema = z.object({
  user_id: z.string(), name: z.string(), subject: z.string(), status: z.string(),
  role: z.string().nullable().optional(), scope: z.string().nullable().optional(),
  vehicle_ids: z.array(z.string()).nullable().optional(),
})
const vehicleSchema = z.object({
  vehicle_id: z.string(), name: z.string(), status: z.string(), subject: z.string(),
})
export const assignmentSchema = z.object({
  expected_version: z.number().int().nonnegative().optional(),
  user_id: z.string().min(1), role: managedRole, scope: managedScope, vehicle_ids: z.array(z.string().min(1)),
}).refine(value => value.scope !== 'selected' || value.vehicle_ids.length > 0, '请选择至少一辆车辆')
  .refine(value => value.scope !== 'none' || value.vehicle_ids.length === 0, '无操作权限范围不能包含车辆')
  .refine(value => value.role !== 'org_admin' || value.scope === 'all', '组织管理员必须使用 all 范围')
export type AdminContext = z.infer<typeof adminContextSchema>
export type ManagedPerson = z.infer<typeof personSchema>
export type ManagedVehicle = z.infer<typeof vehicleSchema>
export type Assignment = z.infer<typeof assignmentSchema>

const onboardingName = z.string().trim().min(1, '请输入名称').max(200)
export const onboardingInputSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('person'), name: onboardingName, email: z.string().trim().email('请输入有效邮箱'),
    role: managedRole, scope: managedScope, vehicle_ids: z.array(z.string().min(1)),
  }),
  z.object({
    kind: z.literal('vehicle'), name: onboardingName,
    vehicle_id: z.string().trim().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/, '车辆 ID 格式无效').optional(),
    vehicle_number: z.string().trim().toLowerCase().regex(/^[a-z0-9][a-z0-9_.-]{0,23}$/, '车辆编号须为 1–24 位字母、数字、点、横线或下划线').optional(),
  }),
]).superRefine((value, ctx) => {
  if (value.kind === 'vehicle') {
    if (Boolean(value.vehicle_id) === Boolean(value.vehicle_number)) ctx.addIssue({ code: 'custom', message: '请填写车辆编号，不要同时指定完整 ID' })
    return
  }
  if (value.scope === 'selected' && !value.vehicle_ids.length) ctx.addIssue({ code: 'custom', message: '请选择至少一辆车辆' })
  if (value.scope === 'none' && value.vehicle_ids.length) ctx.addIssue({ code: 'custom', message: '无操作权限范围不能包含车辆' })
  if (value.role === 'org_admin' && value.scope !== 'all') ctx.addIssue({ code: 'custom', message: '组织管理员必须使用 all 范围' })
})
export type OnboardingInput = z.infer<typeof onboardingInputSchema>
export const onboardingOperationSchema = z.object({
  id: z.string().min(1), kind: z.enum(['person', 'vehicle']), name: z.string(),
  email: z.string().optional(), vehicle_id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/).optional(), status: z.string().min(1),
  stage: z.string(), error_code: z.string().nullable().optional(), user_id: z.string().optional(),
  created_at: z.string(),
})
export type OnboardingOperation = z.infer<typeof onboardingOperationSchema>
export const installationTicketSchema = z.object({ token: z.string().min(1), expires_at: z.string().min(1) })
export type InstallationTicket = z.infer<typeof installationTicketSchema>

export function onboardingNeedsPolling(operation: OnboardingOperation): boolean {
  return !['completed', 'failed', 'cancelled'].includes(operation.status)
}

export function onboardingStatusLabel(status: string): string {
  return ({
    pending: '等待处理（尚未完成）', processing: '正在处理（尚未完成）', running: '正在处理（尚未完成）',
    awaiting_install: '等待车辆安装（尚未接入）', completed: '接入流程已完成',
    failed: '接入失败，可手动重试', cancelled: '接入已取消，权限已移除',
  } as Record<string, string>)[status] ?? '等待后端确认（未知状态，尚未完成）'
}

export class AdminApiError extends Error {
  constructor(message: string, readonly status?: number, readonly code?: string, readonly requestId?: string) {
    super(message)
    this.name = 'AdminApiError'
  }
}

export function adminErrorMessage(error: unknown): string {
  if (!(error instanceof AdminApiError)) return '管理请求失败，请重试。'
  return `${error.message}${error.code ? ` (${error.code})` : ''}${error.requestId ? ` · request_id: ${error.requestId}` : ''}`
}

async function request(path: string, token: string, body?: unknown, signal?: AbortSignal): Promise<unknown> {
  if (!token) throw new AdminApiError('请先登录管理员账号。', 401)
  const controller = new AbortController()
  const cancel = () => controller.abort()
  signal?.addEventListener('abort', cancel, { once: true })
  if (signal?.aborted) controller.abort()
  const timeout = setTimeout(cancel, 8000)
  try {
    const response = await fetch(`${teleopConfig.gatewayUrl.replace(/\/$/, '')}/api/admin${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      cache: 'no-store', signal: controller.signal,
    })
    const text = await response.text()
    let data: unknown
    try { data = text ? JSON.parse(text) : undefined } catch { /* Plain-text Gateway errors are supported. */ }
    if (!response.ok) {
      const detail = z.object({ error: z.string().optional(), code: z.string().optional(), request_id: z.string().optional() }).safeParse(data)
      const code = detail.success ? detail.data.code : undefined
      const message = code === 'MANAGED_DRAIN_REQUIRED'
        ? '未保存：仍有活动视频/驾驶会话，或已签发令牌的 TTL 尚未到期。请安全结束会话并等待令牌过期后，手动重试；不会自动生效。'
        : response.status === 401 ? '登录已失效，请退出后重新登录。'
          : response.status === 403 ? '当前账号没有此组织的管理权限。'
            : (detail.success ? detail.data.error : text.trim()) || `管理请求失败 (${response.status})`
      throw new AdminApiError(message, response.status, code, (detail.success ? detail.data.request_id : undefined) || response.headers.get('X-Request-ID') || undefined)
    }
    if (body === undefined && data === undefined) throw new AdminApiError('管理服务返回了无效 JSON。', response.status, undefined, response.headers.get('X-Request-ID') || undefined)
    return data
  } catch (error) {
    if (error instanceof AdminApiError) throw error
    throw new AdminApiError(controller.signal.aborted
      ? '管理请求超时或已取消；提交结果未知，请刷新列表确认后再重试。'
      : '无法连接管理服务；提交结果未知，请刷新列表确认后再重试。')
  } finally {
    clearTimeout(timeout)
    signal?.removeEventListener('abort', cancel)
  }
}

function parse<S extends z.ZodTypeAny>(schema: S, value: unknown): z.output<S> {
  const result = schema.safeParse(value)
  if (!result.success) throw new AdminApiError('管理服务响应格式不符，请联系平台管理员。')
  return result.data
}
const orgPath = (orgId: string) => `/organizations/${encodeURIComponent(orgId)}`
export async function fetchAdminContext(token: string, signal?: AbortSignal): Promise<AdminContext> {
  return parse(adminContextSchema, await request('/context', token, undefined, signal))
}
export async function fetchAdminPeople(orgId: string, token: string, signal?: AbortSignal): Promise<ManagedPerson[]> {
  return parse(z.array(personSchema), await request(`${orgPath(orgId)}/people`, token, undefined, signal))
}
export async function fetchAdminVehicles(orgId: string, token: string, signal?: AbortSignal): Promise<ManagedVehicle[]> {
  return parse(z.array(vehicleSchema), await request(`${orgPath(orgId)}/vehicles`, token, undefined, signal))
}
export async function createAdminPerson(orgId: string, token: string, input: { name: string; subject: string }): Promise<void> {
  const body = z.object({ name: z.string().trim().min(1), subject: z.string().trim().min(1) }).parse(input)
  await request(`${orgPath(orgId)}/people`, token, body)
}
export async function addExistingMember(orgId: string, token: string, subject: string): Promise<void> {
  const body = z.object({ subject: z.string().trim().min(1).max(512) }).parse({ subject })
  await request(`${orgPath(orgId)}/members`, token, body)
}
export async function createAdminVehicle(orgId: string, token: string, input: { vehicle_id: string; name: string; subject: string }): Promise<void> {
  const body = z.object({ vehicle_id: z.string().trim().min(1), name: z.string().trim().min(1), subject: z.string().trim().min(1) }).parse(input)
  await request(`${orgPath(orgId)}/vehicles`, token, body)
}
export async function saveAdminAssignment(orgId: string, token: string, input: Assignment): Promise<void> {
  const body = assignmentSchema.parse(input)
  await request(`${orgPath(orgId)}/assignments`, token, { ...body, vehicle_ids: body.scope === 'all' ? [] : body.vehicle_ids })
}
const onboardingPath = (orgId: string) => `${orgPath(orgId)}/onboarding`
export async function createOnboarding(orgId: string, token: string, input: OnboardingInput, idempotencyKey: string, signal?: AbortSignal): Promise<OnboardingOperation> {
  const parsed = onboardingInputSchema.safeParse(input)
  if (!parsed.success) throw new AdminApiError(parsed.error.issues[0]?.message || '请检查接入信息。')
  const body = parsed.data
  return parse(onboardingOperationSchema, await request(onboardingPath(orgId), token, {
    ...body, ...(body.kind === 'person' && body.scope === 'all' ? { vehicle_ids: [] } : {}),
    idempotency_key: z.string().uuid().parse(idempotencyKey),
  }, signal))
}
export async function fetchOnboardingOperations(orgId: string, token: string, signal?: AbortSignal): Promise<OnboardingOperation[]> {
  return parse(z.array(onboardingOperationSchema), await request(onboardingPath(orgId), token, undefined, signal))
}
export async function fetchOnboardingOperation(orgId: string, token: string, operationId: string, signal?: AbortSignal): Promise<OnboardingOperation> {
  return parse(onboardingOperationSchema, await request(`${onboardingPath(orgId)}/${encodeURIComponent(operationId)}`, token, undefined, signal))
}
export async function retryOnboarding(orgId: string, token: string, operationId: string, signal?: AbortSignal): Promise<OnboardingOperation> {
  return parse(onboardingOperationSchema, await request(`${onboardingPath(orgId)}/${encodeURIComponent(operationId)}/retry`, token, {}, signal))
}
export async function createInstallationTicket(orgId: string, token: string, operationId: string, signal?: AbortSignal): Promise<InstallationTicket> {
  return parse(installationTicketSchema, await request(`${onboardingPath(orgId)}/${encodeURIComponent(operationId)}/installation-ticket`, token, {}, signal))
}

export async function adminRequest<T, Input>(schema: z.ZodType<T, z.ZodTypeDef, Input>, path: string, token: string, body?: object, signal?: AbortSignal): Promise<T> {
  const result = schema.safeParse(await request(path, token, body, signal))
  if (!result.success) throw new AdminApiError('管理服务响应格式不符，请联系平台管理员。')
  return result.data
}
