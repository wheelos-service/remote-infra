import { z } from 'zod'

export const navigationSchema = z.object({
  page: z.enum(['fleet', 'monitor', 'drive', 'alerts', 'tasks']).default('fleet'),
  vehicle: z.string().default(''),
  fleetQuery: z.string().default(''),
  fleetFilter: z.enum(['all', 'attention', 'offline']).default('all'),
  view: z.enum(['list', 'detail']).default('list'),
  monitorQuery: z.string().default(''),
  monitorFilter: z.enum(['all', 'alerts', 'offline']).default('all'),
  driveVehicle: z.string().default(''),
  driveQuery: z.string().default(''),
  driveFilter: z.enum(['all', 'offline']).default('all'),
  alertSection: z.enum(['dashboard', 'work', 'history']).default('dashboard'),
  query: z.string().default(''),
  alertVehicle: z.string().default(''),
  state: z.enum(['pending', 'all', 'recovered']).default('pending'),
  severity: z.enum(['all', 'critical', 'FATAL', 'ERROR', 'WARN']).default('all'),
  period: z.enum(['retained', '24h']).default('retained'),
  selectedVehicle: z.string().default(''),
  selectedAlert: z.string().default(''),
  fromAlerts: z.enum(['yes', 'no']).default('no'),
})
export type OperationsNavigation = z.infer<typeof navigationSchema>
export const defaultNavigation = navigationSchema.parse({})
export function readNavigation(search: string) {
  return navigationSchema.safeParse(Object.fromEntries(new URLSearchParams(search)))
}
export function navigationSearch(state: OperationsNavigation) {
  const parsed = navigationSchema.parse(state)
  const search = new URLSearchParams()
  for (const key of Object.keys(parsed) as (keyof OperationsNavigation)[]) {
    if (parsed[key] !== defaultNavigation[key]) search.set(key, parsed[key])
  }
  return search.toString()
}
