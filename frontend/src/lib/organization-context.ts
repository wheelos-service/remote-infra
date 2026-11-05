import { z } from 'zod'
import { teleopConfig } from './teleop-config'

const managedContextSchema = z.object({
  mode: z.literal('managed'),
  organizations: z.array(z.object({
    org_id: z.string().uuid(),
    name: z.string(),
    role: z.enum(['viewer', 'remote_operator', 'org_admin', '']),
    can_manage: z.boolean(),
    scope: z.enum(['none', 'selected', 'all']),
    vehicle_ids: z.array(z.string()),
  }).strict()),
}).strict()
export const memberContextSchema = z.discriminatedUnion('mode', [
  managedContextSchema,
  z.object({
    mode: z.literal('static'),
    organizations: z.array(z.never()).max(0),
    control_vehicle_ids: z.array(z.string().min(1)),
  }).strict(),
])
export type MemberContext = z.infer<typeof memberContextSchema>
export type MemberOrganization = z.infer<typeof managedContextSchema>['organizations'][number]

export function hasVehicleContext(context: MemberContext | undefined, organizationId: string): boolean {
  return context?.mode === 'static' ||
    (context?.mode === 'managed' && context.organizations.some(org => org.org_id === organizationId))
}

export function canControlVehicle(context: MemberContext | undefined, organizationId: string, vehicleId: string): boolean {
  if (context?.mode === 'static') return context.control_vehicle_ids.includes(vehicleId)
  const organization = context?.organizations.find(org => org.org_id === organizationId)
  return organization?.role === 'remote_operator' &&
    (organization.scope === 'all' || (organization.scope === 'selected' && organization.vehicle_ids.includes(vehicleId)))
}
export const organizationRoleLabels: Record<string, string> = {
  viewer: '查看者', remote_operator: '操作员', org_admin: '管理员', '': '未分配角色',
}

let selectedOrganization = ''
export function setRequestOrganization(id: string) { selectedOrganization = id }
export function requestOrganization() { return selectedOrganization }
export function organizationHeaders(id = selectedOrganization): Record<string, string> {
  return id ? { 'X-Organization-ID': id } : {}
}

export async function fetchMemberContext(token: string, signal: AbortSignal) {
  const response = await fetch(`${teleopConfig.gatewayUrl.replace(/\/$/, '')}/api/organizations/context`, {
    headers: { Authorization: `Bearer ${token}` }, signal, cache: 'no-store',
  })
  if (!response.ok) throw new Error(`无法获取组织成员上下文 (${response.status})`)
  return memberContextSchema.parse(await response.json())
}

export function safeReturnPath(path: string | null): string {
  if (path === '/admin') return path
  if (path === '/') return '/'
  if (path?.startsWith('/?') && !path.includes('#') && !/[\r\n\\]/.test(path)) {
    const query = new URLSearchParams(path.slice(2))
    if (['fleet', 'monitor', 'drive', 'alerts', 'tasks'].includes(query.get('page') ?? 'fleet')) return path
  }
  return '/'
}
