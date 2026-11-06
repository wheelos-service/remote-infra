import { z } from 'zod'
import { adminRequest, installationTicketSchema, type InstallationTicket } from './admin-api'

export const lifecycleOperationSchema = z.object({
  id: z.string().uuid(), org_id: z.string().uuid(), actor_user_id: z.string().uuid(),
  action: z.string(), target_id: z.string(), reason: z.string(),
  authorization_version: z.number().int().nonnegative(),
  installation_status: z.string().default(''),
  provider_status: z.enum(['not_required', 'pending', 'failed', 'manual_required', 'confirmed']),
  error_code: z.string(), attempts: z.number().int().nonnegative(), created_at: z.string(), updated_at: z.string(),
})
export const registrationSchema = z.object({
  first_authenticated_at: z.string().nullable().optional(),
  kind: z.enum(['person', 'vehicle']), target_id: z.string(), status: z.string(), binding_status: z.string(),
  operation_id: z.string(), stage: z.string(), provisioning_status: z.string(), error_code: z.string(), updated_at: z.string().nullable(),
})
const auditPageSchema = z.object({
  items: z.array(z.object({ id: z.string().uuid(), actor_user_id: z.string(), subject_user_id: z.string(), action: z.string(),
    authorization_version: z.number(), details: z.record(z.union([z.string(), z.number(), z.boolean(), z.array(z.string()), z.null()])), created_at: z.string() })),
  next_cursor: z.string(),
})
export type LifecycleOperation = z.infer<typeof lifecycleOperationSchema>
export type Registration = z.infer<typeof registrationSchema>
export type AuditPage = z.infer<typeof auditPageSchema>
export type LifecycleAction = 'member_remove' | 'member_rejoin' | 'vehicle_remove' | 'vehicle_reactivate' | 'credential_revoke' | 'vehicle_transfer' | 'credential_rotate'
export type LifecycleInput = { idempotency_key: string; expected_version: number; reason: string; verified_subject?: string; destination_org_id?: string }
export type AuditFilters = { actor: string; target: string; action: string; outcome: string; from: string; until: string }
const orgPath = (org: string) => `/organizations/${encodeURIComponent(org)}`

export function changeLifecycle(org: string, token: string, target: string, action: LifecycleAction, input: LifecycleInput, signal: AbortSignal): Promise<LifecycleOperation> {
  const paths: Record<LifecycleAction, string> = {
    member_remove: `members/${encodeURIComponent(target)}/remove`, member_rejoin: `members/${encodeURIComponent(target)}/rejoin`,
    credential_rotate: `vehicles/${encodeURIComponent(target)}/credential-rotations`,
    vehicle_transfer: `vehicles/${encodeURIComponent(target)}/transfer`,
    vehicle_remove: `vehicles/${encodeURIComponent(target)}/remove`, vehicle_reactivate: `vehicles/${encodeURIComponent(target)}/reactivate`,
    credential_revoke: `vehicles/${encodeURIComponent(target)}/credential-revocations`,
  }
  return adminRequest(lifecycleOperationSchema, `${orgPath(org)}/${paths[action]}`, token, input, signal)
}
export function fetchLifecycle(org: string, token: string, signal: AbortSignal): Promise<LifecycleOperation[]> {
  return adminRequest(z.array(lifecycleOperationSchema), `${orgPath(org)}/lifecycle-operations`, token, undefined, signal)
}
export function fetchRegistration(org: string, token: string, target: string, kind: 'person' | 'vehicle', signal: AbortSignal): Promise<Registration> {
  return adminRequest(registrationSchema, `${orgPath(org)}/${kind === 'person' ? 'people' : 'vehicles'}/${encodeURIComponent(target)}/registration`, token, undefined, signal)
}
export async function reconcileLifecycle(org: string, token: string, id: string, action: 'retry' | 'confirm', reason: string, signal: AbortSignal): Promise<void> {
  await adminRequest(z.undefined(), `${orgPath(org)}/lifecycle-operations/${encodeURIComponent(id)}/${action}`, token, { reason }, signal)
}
export function fetchAudit(org: string, token: string, filters: AuditFilters, cursor: string, signal: AbortSignal): Promise<AuditPage> {
  const query = new URLSearchParams({ limit: '25' })
  for (const [key, value] of Object.entries(filters)) if (value) query.set(key, value)
  if (cursor) query.set('cursor', cursor)
  return adminRequest(auditPageSchema, `${orgPath(org)}/audit?${query}`, token, undefined, signal)
}

export function createRotationTicket(org: string, token: string, id: string, signal: AbortSignal): Promise<InstallationTicket> {
  return adminRequest(installationTicketSchema, `${orgPath(org)}/lifecycle-operations/${encodeURIComponent(id)}/installation-ticket`, token, {}, signal)
}
