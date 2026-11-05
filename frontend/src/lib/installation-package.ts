import { z } from 'zod'
import type { InstallationTicket } from './admin-api'

export const installationPackageSchema = z.object({
  schema_version: z.literal(1),
  gateway_url: z.string().url().max(2048).refine(value => {
    const url = new URL(value)
    return url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash && url.pathname === '/'
  }),
  vehicle_id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/),
  operation_id: z.string().uuid(),
  expires_at: z.string().datetime({ offset: true }),
  installation_ticket: z.string().min(1).max(4096).regex(/^[\x21-\x7e]+$/),
}).strict()

export function buildInstallationPackage(ticket: InstallationTicket, vehicleId: string, operationId: string, gateway: string): string {
  const value = installationPackageSchema.parse({
    schema_version: 1, gateway_url: gateway.replace(/\/$/, ''), vehicle_id: vehicleId,
    operation_id: operationId, expires_at: ticket.expires_at, installation_ticket: ticket.token,
  })
  if (Date.parse(value.expires_at) <= Date.now()) throw new Error('安装令牌已过期，请重新签发。')
  return JSON.stringify(value, null, 2) + '\n'
}

export function downloadInstallationPackage(contents: string, vehicleId: string): void {
  const url = URL.createObjectURL(new Blob([contents], { type: 'application/json' }))
  const link = document.createElement('a')
  try {
    link.href = url
    link.download = `${vehicleId.replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 64)}-enrollment.json`
    document.body.append(link)
    link.click()
  } finally {
    link.remove()
    URL.revokeObjectURL(url)
  }
}
