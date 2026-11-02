import type { VehicleData } from './vehicle-data-api'
import { healthFreshness } from './vehicle-data-api'
import { getSampleFreshness, directoryOnline, type ReceivedVehicle } from './vehicle-telemetry'
import type { OverviewVehicle } from './fleet-overview'

export interface MonitorListState {
  query: string
  filter: 'all' | 'alerts' | 'offline'
  scrollTop: number
}
export const initialMonitorList: MonitorListState = { query: '', filter: 'all', scrollTop: 0 }

export interface BevPose { x: number; y: number; heading: number }
export function bevPoint(point: { x: number; y: number }, pose: BevPose, width: number, height: number, range: number) {
  if (![point.x, point.y, pose.x, pose.y, pose.heading, width, height, range].every(Number.isFinite) ||
      width <= 0 || height <= 0 || range <= 0) throw new Error('Invalid vehicle BEV coordinates')
  const dx = point.x - pose.x, dy = point.y - pose.y
  const scale = Math.min(width, height) / range
  const forward = dx * Math.cos(pose.heading) + dy * Math.sin(pose.heading)
  const left = -dx * Math.sin(pose.heading) + dy * Math.cos(pose.heading)
  return { x: width / 2 - left * scale, y: height / 2 - forward * scale }
}

export function bevPose(row: OverviewVehicle, previous?: BevPose): BevPose | undefined {
  const position = row.position
  if (!position || typeof position.heading !== 'number' ||
      ![position.x, position.y, position.heading].every(Number.isFinite)) return undefined
  return row.online && row.localizationFresh
    ? { x: position.x, y: position.y, heading: position.heading } : previous ?? { ...position, heading: position.heading }
}

export interface HealthCheck {
  key: string
  label: string
  status: 'FATAL' | 'ERROR' | 'WARN' | 'UNKNOWN' | 'OK'
  detail: string
  age: number | null
}
export function vehicleHealthChecks(entry: ReceivedVehicle, data: VehicleData | undefined, now: number): HealthCheck[] {
  const elapsed = Math.max(0, now - entry.receivedAtClientMs)
  const online = directoryOnline(entry, false, now)
  const chassis = getSampleFreshness(entry.state?.chassis, entry, now)
  const localization = getSampleFreshness(entry.state?.localization, entry, now)
  const freshChassis = online && chassis.state === 'fresh'
  const message = entry.state?.chassis.message
  const errorKnown = message?.error_code !== null && message?.error_code !== undefined ||
    message?.chassis_error_mask !== null && message?.chassis_error_mask !== undefined
  const faulty = (message?.error_code ?? 0) !== 0 || (message?.chassis_error_mask ?? 0) !== 0 ||
    message?.driving_mode === 'EMERGENCY_MODE'
  const health = data ? healthFreshness(data, elapsed) : { fresh: false, age: null }
  const monitor = data?.health?.payload.sample.message
  const checks: HealthCheck[] = [
    { key: 'connection', label: '遥测连接', status: online ? 'OK' : 'UNKNOWN',
      detail: online ? '正在接收车辆数据' : '未收到新鲜数据，不能确认当前设备状态',
      age: entry.received_at_ms === null ? null : Math.max(0, entry.server_time_ms - entry.received_at_ms) + elapsed },
    { key: 'chassis', label: '底盘检查', status: !freshChassis || !message ? 'UNKNOWN' : faulty ? 'ERROR' : !errorKnown ? 'UNKNOWN' : 'OK',
      detail: !freshChassis ? '底盘数据缺失、过期或时间异常' : faulty ? `错误码 ${message?.error_code ?? '未知'} · 错误掩码 ${message?.chassis_error_mask ?? '未知'} · ${message?.driving_mode === 'EMERGENCY_MODE' ? '紧急模式' : '请检查底盘'}`
        : !errorKnown ? '未提供底盘错误字段'
          : '已上报的底盘错误字段未见异常', age: chassis.sourceAgeMs },
    { key: 'localization', label: '定位数据', status: online && localization.state === 'fresh' && entry.state?.localization.message ? 'OK' : 'UNKNOWN',
      detail: online && localization.state === 'fresh' && entry.state?.localization.message ? '收到新鲜定位数据；不等于定位精度已验证' : '定位数据缺失、过期或时间异常',
      age: localization.sourceAgeMs },
    { key: 'monitor', label: '健康监测数据', status: online && health.fresh && monitor ? 'OK' : 'UNKNOWN',
      detail: health.fresh && online && monitor ? '已接收完整健康快照' : '健康快照缺失、过期、截断或时间异常', age: health.age },
  ]
  if (monitor) {
    const add = (key: string, value: { status: HealthCheck['status'] | null; message: string | null } | null) => {
      const current = online && health.fresh
      checks.push({ key, label: key, status: current ? value?.status ?? 'UNKNOWN' : 'UNKNOWN',
        detail: current ? value?.message || '未提供检查说明' : `当前不可确认${value?.message ? `；最近记录：${value.message}` : ''}`, age: health.age })
    }
    for (const [name, component] of Object.entries(monitor.components)) {
      if (!component) add(`组件/${name}`, null)
      else for (const [check, value] of Object.entries(component)) add(`组件/${name}/${check}`, value)
    }
    for (const [name, value] of Object.entries(monitor.hmi_modules)) add(`模块/${name}`, value)
    for (const [name, value] of Object.entries(monitor.other_components)) add(`其他检查/${name}`, value)
    checks.push({ key: 'emergency', label: '紧急停车要求',
      status: !online || !health.fresh || monitor.require_emergency_stop === null ? 'UNKNOWN' : monitor.require_emergency_stop ? 'FATAL' : 'OK',
      detail: !online || !health.fresh ? '健康数据不可确认' : monitor.require_emergency_stop === null ? '未提供此状态'
        : monitor.require_emergency_stop ? '设备健康监测要求紧急停车；不是平台发出的停车命令' : '未上报紧急停车要求', age: health.age })
  }
  const rank = { FATAL: 0, ERROR: 1, WARN: 2, UNKNOWN: 3, OK: 4 }
  return checks.sort((a, b) => rank[a.status] - rank[b.status] || a.key.localeCompare(b.key))
}
