import type { FleetMap } from './fleet-map'
import type { VehicleData } from './vehicle-data-api'
import { healthFreshness } from './vehicle-data-api'
import { directoryControl, directoryOnline, getSampleFreshness, type ReceivedVehicle } from './vehicle-telemetry'
import { pendingAlertCount } from './vehicle-alerts'

export type DrivingMode = 'auto' | 'manual' | 'partial' | 'emergency' | 'unknown'
export type FleetHealth = 'fault' | 'degraded' | 'unknown' | 'ok'
export interface OverviewVehicle {
  id: string
  name: string
  online: boolean
  receiptAge: number | null
  mode: DrivingMode
  modeLabel: string
  health: FleetHealth
  healthLabel: string
  localizationFresh: boolean
  sourceAge: number | null
  position?: { x: number; y: number; heading?: number }
  locationReason: string
  speed: number | null
  battery: number | null
  gear: string
  control: string
  stream: string | null
  sequence: number | null
}

export function activeFaults(data: VehicleData | undefined): number {
  return pendingAlertCount(data)
}

export function overviewVehicle(entry: ReceivedVehicle, data: VehicleData | undefined, map: FleetMap, now: number): OverviewVehicle {
  const online = directoryOnline(entry, false, now)
  const chassisFresh = online && getSampleFreshness(entry.state?.chassis, entry, now).state === 'fresh'
  const localization = getSampleFreshness(entry.state?.localization, entry, now)
  const localizationFresh = online && localization.state === 'fresh'
  const chassis = entry.state?.chassis.message
  const rawMode = chassisFresh ? chassis?.driving_mode : undefined
  const mode: DrivingMode = rawMode === 'COMPLETE_AUTO_DRIVE' ? 'auto'
    : rawMode === 'COMPLETE_MANUAL' ? 'manual'
      : rawMode === 'AUTO_STEER_ONLY' || rawMode === 'AUTO_SPEED_ONLY' ? 'partial'
        : rawMode === 'EMERGENCY_MODE' ? 'emergency' : 'unknown'
  const message = data?.health?.payload.sample.message
  const elapsed = Math.max(0, now - entry.receivedAtClientMs)
  const monitorFresh = Boolean(data && healthFreshness(data, elapsed).fresh)
  const checks = message ? [
    ...Object.values(message.components).flatMap((value) => value ? Object.values(value) : [null]),
    ...Object.values(message.hmi_modules), ...Object.values(message.other_components),
  ] : []
  const fault = chassisFresh && ((chassis?.error_code ?? 0) !== 0 || (chassis?.chassis_error_mask ?? 0) !== 0) ||
    mode === 'emergency' || monitorFresh && (message?.require_emergency_stop === true ||
      checks.some((check) => check?.status === 'ERROR' || check?.status === 'FATAL'))
  const degraded = monitorFresh && checks.some((check) => check?.status === 'WARN')
  const incomplete = !online || !chassisFresh || !localizationFresh || !monitorFresh ||
    !message || message.components_truncated || !checks.length ||
    checks.some((check) => !check || check.status === null || check.status === 'UNKNOWN')
  const rawPosition = entry.state?.localization.message
  const position = rawPosition?.position
  const matches = rawPosition?.frame_id === map.frame_id
  const valid = matches && typeof position?.x === 'number' && typeof position.y === 'number' &&
    position.x >= map.bounds[0] && position.x <= map.bounds[2] &&
    position.y >= map.bounds[1] && position.y <= map.bounds[3]
  const health: FleetHealth = fault ? 'fault' : degraded ? 'degraded' : incomplete || !valid ? 'unknown' : 'ok'
  const control = directoryControl(entry, false, now)
  return {
    id: entry.vehicle_id, name: entry.name, online,
    receiptAge: entry.received_at_ms === null ? null : Math.max(0, entry.server_time_ms - entry.received_at_ms) + elapsed,
    mode, modeLabel: mode === 'auto' ? '自动驾驶' : mode === 'manual' ? '人工驾驶'
      : mode === 'partial' ? '部分自动' : mode === 'emergency' ? '紧急模式' : '模式未知',
    health, healthLabel: health === 'fault' ? '故障' : health === 'degraded' ? '警告'
      : health === 'unknown' ? '健康未知' : '已采集项正常',
    localizationFresh, sourceAge: localization.sourceAgeMs,
    position: valid ? { x: position.x!, y: position.y!, heading: rawPosition?.heading_rad ?? undefined } : undefined,
    locationReason: !matches ? '坐标系不匹配 / 缺失' : !valid ? '定位缺失 / 超出地图范围'
      : !online ? '离线 · 最后已知位置' : !localizationFresh ? '定位过期 / 未知 · 非当前位置' : '定位新鲜',
    speed: chassisFresh && typeof chassis?.speed_mps === 'number' ? chassis.speed_mps * 3.6 : null,
    battery: chassisFresh ? chassis?.battery_soc_percentage ?? null : null,
    gear: !chassisFresh ? '—' : chassis?.gear_location === 'GEAR_DRIVE' ? 'D'
      : chassis?.gear_location === 'GEAR_REVERSE' ? 'R' : chassis?.gear_location === 'GEAR_PARKING' ? 'P'
        : chassis?.gear_location === 'GEAR_NEUTRAL' ? 'N' : '—',
    control: control.status === 'unknown' ? '远程占用未知' : control.status === 'free' ? '无远程会话'
      : control.is_self ? '本人远程占用' : '其他终端远程占用',
    stream: entry.state?.stream_id ?? null, sequence: entry.state?.sequence ?? null,
  }
}

export function fleetMetrics(rows: OverviewVehicle[], data: Record<string, VehicleData>) {
  return {
    total: rows.length, online: rows.filter((row) => row.online).length,
    auto: rows.filter((row) => row.mode === 'auto').length,
    manual: rows.filter((row) => row.mode === 'manual').length,
    unknown: rows.filter((row) => row.mode === 'unknown').length,
    faults: rows.reduce((count, row) => count + activeFaults(data[row.id]), 0),
    attention: rows.filter((row) => !row.online || row.health !== 'ok' || !row.localizationFresh).length,
  }
}

export function markerColor(row: OverviewVehicle) {
  return !row.online ? '#94a3b8' : row.health === 'fault' ? '#fb7185'
    : !row.localizationFresh || row.health !== 'ok' ? '#fbbf24' : '#38bdf8'
}

export interface MapViewport { x: number; y: number; width: number; height: number }
export function fitMap(bounds: FleetMap['bounds'], width: number, height: number): MapViewport {
  if (width <= 0 || height <= 0) throw new Error('Invalid map viewport')
  const [minX, minY, maxX, maxY] = bounds
  const scale = Math.max((maxX - minX) / width, (maxY - minY) / height) * 1.15
  return { x: (minX + maxX) / 2, y: (minY + maxY) / 2, width: width * scale, height: height * scale }
}

export function screenPoint(position: { x: number; y: number }, view: MapViewport, width: number, height: number) {
  return { x: width / 2 + (position.x - view.x) * width / view.width, y: height / 2 - (position.y - view.y) * height / view.height }
}

// Keep labels separate without moving the actual vehicle position.
export function markerLabels(rows: OverviewVehicle[], view: MapViewport, width: number, height: number, selected: string) {
  const occupied: { x: number; y: number }[] = []
  return [...rows].filter((row) => row.position).sort((a, b) =>
    Number(b.id === selected) - Number(a.id === selected) || a.id.localeCompare(b.id)).map((row) => {
    const position = screenPoint(row.position!, view, width, height)
    if (position.x < -20 || position.x > width + 20 || position.y < -20 || position.y > height + 20) {
      return { row, position, label: undefined }
    }
    const offsets = [[18, -30], [18, 12], [-122, -30], [-122, 12], [18, -64], [18, 46]]
    const label = offsets.map(([x, y]) => ({ x: Math.max(4, Math.min(width - 110, position.x + x)), y: Math.max(4, Math.min(height - 25, position.y + y)) }))
      .find((candidate) => occupied.every((previous) => Math.abs(candidate.x - previous.x) >= 112 || Math.abs(candidate.y - previous.y) >= 27))
    if (label) occupied.push(label)
    return { row, position, label }
  })
}
