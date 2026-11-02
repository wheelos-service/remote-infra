import type { VehicleData } from './vehicle-data-api'

export type AlertEvent = VehicleData['events'][number]
export type AlertState = 'active' | 'recovered' | 'unknown'
export type AlertSeverity = AlertEvent['severity'] | 'UNKNOWN'
export type AlertSection = 'dashboard' | 'work' | 'history'
export interface VehicleAlert {
  id: string
  vehicleId: string
  faultKey: string
  severity: AlertSeverity
  state: AlertState
  startedAt: number
  updatedAt: number
  recoveredAt: number | null
  historyIncomplete: boolean
  events: AlertEvent[]
}
export interface VehicleAlertGroup {
  vehicleId: string
  name: string
  alerts: VehicleAlert[]
  pending: number
  severity: AlertSeverity
  updatedAt: number
}
export interface AlertFilters {
  query: string
  vehicle: string
  state: 'pending' | 'all' | 'recovered'
  severity: 'all' | 'critical' | 'FATAL' | 'ERROR' | 'WARN'
  period: 'retained' | '24h'
  selectedVehicle: string
  selectedAlert: string
}
export const initialAlertFilters: AlertFilters = {
  query: '', vehicle: '', state: 'pending', severity: 'all', period: 'retained',
  selectedVehicle: '', selectedAlert: '',
}
export const severityRank = (severity: AlertSeverity) =>
  severity === 'FATAL' ? 4 : severity === 'ERROR' ? 3 : severity === 'WARN' ? 2 : severity === 'UNKNOWN' ? 1 : 0
export const severityLabel = (severity: AlertSeverity) =>
  severity === 'FATAL' ? '紧急' : severity === 'ERROR' ? '严重' : severity === 'WARN' ? '警告' : severity === 'OK' ? '正常' : '级别未知'
export const alertStateLabel = (state: AlertState) =>
  state === 'active' ? '待恢复' : state === 'recovered' ? '已恢复' : '恢复状态待确认'

// An occurrence ends only on an explicit recovery, never on a missing event or an acknowledgement.
export function vehicleAlerts(data: VehicleData | undefined): VehicleAlert[] {
  if (!data) return []
  const faults = new Map<string, AlertEvent[]>()
  for (const event of data.events) {
    if (event.vehicle_id !== data.vehicle_id) throw new Error('告警车辆身份不一致')
    const records = faults.get(event.fault_key) ?? []
    records.push(event)
    faults.set(event.fault_key, records)
  }
  const alerts: VehicleAlert[] = []
  for (const [faultKey, records] of faults) {
    const events = [...new Map(records.map((event) => [event.event_id, event])).values()]
      .sort((a, b) => a.occurred_at_ms - b.occurred_at_ms || a.event_id.localeCompare(b.event_id))
    let current: VehicleAlert | undefined
    for (let index = 0; index < events.length;) {
      const time = events[index].occurred_at_ms
      const batch: AlertEvent[] = []
      while (index < events.length && events[index].occurred_at_ms === time) batch.push(events[index++])
      const hasRecovery = batch.some((event) => event.transition === 'recovered')
      const nonRecovery = batch.filter((event) => event.transition !== 'recovered')
      if (!current || current.state === 'recovered' && nonRecovery.length) {
        current = {
          id: `${data.vehicle_id}:${batch[0].event_id}`, vehicleId: data.vehicle_id, faultKey,
          severity: 'UNKNOWN', state: 'unknown', startedAt: time, updatedAt: time,
          recoveredAt: null, historyIncomplete: !batch.some((event) => event.transition === 'raised'), events: [],
        }
        alerts.push(current)
      }
      current.events.push(...batch)
      current.updatedAt = time
      if (nonRecovery.length) {
        current.severity = nonRecovery.reduce<AlertSeverity>((highest, event) =>
          severityRank(event.severity) > severityRank(highest) ? event.severity : highest, 'UNKNOWN')
      }
      current.state = hasRecovery && nonRecovery.length ? 'unknown' : hasRecovery ? 'recovered' : 'active'
      current.recoveredAt = current.state === 'recovered' ? time : null
    }
  }
  return alerts.sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id))
}

export function pendingAlertCount(data: VehicleData | undefined): number {
  return vehicleAlerts(data).filter((alert) => alert.state !== 'recovered').length
}

export function groupVehicleAlerts(records: Record<string, VehicleData>, names: Record<string, string> = {}): VehicleAlertGroup[] {
  return Object.values(records).map((data) => {
    const alerts = vehicleAlerts(data).sort((a, b) =>
      Number(b.state !== 'recovered') - Number(a.state !== 'recovered') ||
      severityRank(b.severity) - severityRank(a.severity) || b.updatedAt - a.updatedAt || a.id.localeCompare(b.id))
    const pending = alerts.filter((alert) => alert.state !== 'recovered')
    const ranked = pending.length ? pending : alerts
    return {
      vehicleId: data.vehicle_id, name: names[data.vehicle_id] ?? data.vehicle_id, alerts, pending: pending.length,
      severity: ranked.reduce<AlertSeverity>((highest, alert) =>
        severityRank(alert.severity) > severityRank(highest) ? alert.severity : highest, 'UNKNOWN'),
      updatedAt: Math.max(0, ...alerts.map((alert) => alert.updatedAt)),
    }
  }).filter((group) => group.alerts.length > 0).sort((a, b) =>
    Number(b.pending > 0) - Number(a.pending > 0) || severityRank(b.severity) - severityRank(a.severity) ||
    a.vehicleId.localeCompare(b.vehicleId))
}

export function filterVehicleAlerts(groups: VehicleAlertGroup[], filters: AlertFilters, now: number): VehicleAlertGroup[] {
  const query = filters.query.trim().toLowerCase()
  return groups.flatMap((group) => {
    if (filters.vehicle && group.vehicleId !== filters.vehicle) return []
    const vehicleMatch = `${group.vehicleId} ${group.name}`.toLowerCase().includes(query)
    const alerts = group.alerts.filter((alert) =>
      (filters.state === 'all' || filters.state === 'pending' && alert.state !== 'recovered' ||
        filters.state === 'recovered' && alert.state === 'recovered') &&
      (filters.severity === 'all' || alert.severity === filters.severity ||
        filters.severity === 'critical' && (alert.severity === 'ERROR' || alert.severity === 'FATAL')) &&
      (filters.period === 'retained' || alert.events.some((event) => event.occurred_at_ms >= now - 86_400_000 && event.occurred_at_ms <= now)) &&
      (!query || vehicleMatch || `${alert.faultKey} ${alert.events.map((event) => `${event.event_id} ${event.message}`).join(' ')}`.toLowerCase().includes(query)))
    return alerts.length ? [{ ...group, alerts }] : []
  })
}

export function alertPeriodSummary(groups: VehicleAlertGroup[], start: number, end: number) {
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end) throw new Error('请选择有效的统计时间范围')
  const inside = (value: number) => value >= start && value <= end
  const added = groups.flatMap((group) => group.alerts.filter((alert) =>
    alert.events.some((event) => event.transition === 'raised' && inside(event.occurred_at_ms))))
  const recovered = groups.flatMap((group) => group.alerts.filter((alert) =>
    alert.state === 'recovered' && alert.recoveredAt !== null && inside(alert.recoveredAt)))
  return { vehicles: new Set(added.map((alert) => alert.vehicleId)).size, added: added.length, recovered: recovered.length }
}

export interface VehicleTimelineItem {
  id: string
  at: number
  kind: 'device' | 'human'
  event: AlertEvent
  operator?: string
}

export function vehicleTimeline(data: VehicleData | undefined): VehicleTimelineItem[] {
  if (!data) return []
  const events = new Map(vehicleAlerts(data).flatMap((alert) => alert.events).map((event) => [event.event_id, event]))
  const items: VehicleTimelineItem[] = [...events.values()].map((event) =>
    ({ id: `device:${event.event_id}`, at: event.occurred_at_ms, kind: 'device', event }))
  const seen = new Set<string>()
  for (const ack of data.acknowledgements) {
    const event = events.get(ack.event_id)
    if (!event) continue
    const id = JSON.stringify(['human', ack.event_id, ack.operator_id, ack.acknowledged_at_ms])
    if (seen.has(id)) continue
    seen.add(id)
    items.push({ id, at: ack.acknowledged_at_ms, kind: 'human', event, operator: ack.operator_id })
  }
  return items.sort((a, b) => a.at - b.at || a.id.localeCompare(b.id))
}
