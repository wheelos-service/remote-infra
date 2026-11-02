import type { FleetMap } from './fleet-map'
import type { VehicleData } from './vehicle-data-api'
import { healthFreshness } from './vehicle-data-api'
import { directoryOnline, getSampleFreshness, type ReceivedVehicle } from './vehicle-telemetry'

export type DashboardStatus = 'AUTONOMOUS' | 'IDLE' | 'ALARM' | 'OFFLINE'
export interface DashboardVehicle {
  id: string
  name: string
  status: DashboardStatus
  statusLabel: string
  speedKmh: number | null
  lastUpdate: string
  locationLabel: string
  gear: 'P' | 'R' | 'N' | 'D' | '—'
  batteryPercent?: number
  runModeLabel: string
  localizationLabel: string
  position?: { top: string; left: string }
  heading?: number
  steeringPercent?: number
}

export function mapPercent(map: FleetMap, x: number, y: number) {
  const [minX, minY, maxX, maxY] = map.bounds
  return {
    left: `${5 + (x - minX) / (maxX - minX) * 90}%`,
    top: `${5 + (maxY - y) / (maxY - minY) * 90}%`,
  }
}

export function dashboardVehicle(entry: ReceivedVehicle, data: VehicleData | undefined, map: FleetMap, now: number): DashboardVehicle {
  const online = directoryOnline(entry, false, now)
  const chassisFresh = online && getSampleFreshness(entry.state?.chassis, entry, now).state === 'fresh'
  const localizationFresh = online && getSampleFreshness(entry.state?.localization, entry, now).state === 'fresh'
  const chassis = entry.state?.chassis.message
  const localization = entry.state?.localization.message
  const monitor = data?.health?.payload.sample.message
  const healthySource = data && healthFreshness(data, Math.max(0, now - entry.receivedAtClientMs)).fresh
  const unhealthy = !healthySource || monitor?.require_emergency_stop === true || chassis?.error_code !== undefined && chassis.error_code !== null && chassis.error_code !== 0
  const status: DashboardStatus = !online ? 'OFFLINE'
    : !chassisFresh || !localizationFresh || unhealthy ? 'ALARM'
      : chassis?.speed_mps === 0 ? 'IDLE' : 'AUTONOMOUS'
  const position = localization?.position
  const mode = chassis?.driving_mode
  const gear = chassisFresh ? chassis?.gear_location : undefined
  return {
    id: entry.vehicle_id, name: entry.name, status,
    statusLabel: !online ? '离线 · 旧快照' : !chassisFresh ? '底盘过期 / 未知'
      : !localizationFresh ? '定位过期 / 未知' : unhealthy ? '模拟故障' : status === 'IDLE' ? '停车待命' : '模拟自动驾驶',
    speedKmh: chassisFresh && typeof chassis?.speed_mps === 'number' ? chassis.speed_mps * 3.6 : null,
    lastUpdate: entry.received_at_ms ? new Date(entry.received_at_ms).toLocaleTimeString('zh-CN', { hour12: false }) : '未知',
    locationLabel: localization?.frame_id === map.frame_id && typeof position?.x === 'number' && typeof position.y === 'number'
      ? `${map.version} · X ${position.x.toFixed(1)} / Y ${position.y.toFixed(1)} m` : '地图坐标未知 / 不匹配',
    position: localization?.frame_id === map.frame_id && typeof position?.x === 'number' && typeof position.y === 'number'
      ? mapPercent(map, position.x, position.y) : undefined,
    heading: localization?.heading_rad ?? undefined,
    gear: gear === 'GEAR_DRIVE' ? 'D' : gear === 'GEAR_REVERSE' ? 'R' : gear === 'GEAR_PARKING' ? 'P' : gear === 'GEAR_NEUTRAL' ? 'N' : '—',
    batteryPercent: chassisFresh ? chassis?.battery_soc_percentage ?? undefined : undefined,
    steeringPercent: chassisFresh ? chassis?.steering_percentage ?? undefined : undefined,
    runModeLabel: !chassisFresh ? '模式未知 / 过期' : mode === 'COMPLETE_AUTO_DRIVE' ? '自动驾驶 · Mock'
      : mode === 'COMPLETE_MANUAL' ? '人工驾驶 · Mock' : '模式未知',
    localizationLabel: localizationFresh ? '模拟定位 · 新鲜' : online ? '定位过期 / 未知' : '离线 · 旧定位',
  }
}

export function dashboardDetails(data: VehicleData | undefined) {
  const monitor = data?.health?.payload.sample.message
  return {
    diagnosis: monitor
      ? Object.entries(monitor.hmi_modules).map(([name, check]) => `${name}：${check?.status ?? 'UNKNOWN'} · ${check?.message ?? '无信息'}`).join('；')
      : '尚无 Monitor 数据，不能推断健康。',
    events: data?.events.length ? data.events.map((event) => `${event.transition} · ${event.message}`).join('；') : '尚无事件，不代表车辆健康。',
    tasks: data?.tasks.length ? data.tasks.map((task) => `${task.request.request_id} · ${task.result?.status ?? '仅云端落库'} · ${task.result?.reason ?? '等待设备结果'}`).join('；') : '尚无任务记录。',
    profile: data?.profile ? `车型 ${data.profile.payload.model}；软件 ${data.profile.payload.software_version}；地图 ${data.profile.payload.map_id}；任务模式 ${data.profile.payload.task_mode}` : '尚无车辆档案。',
  }
}

export function dashboardAlerts(records: Record<string, VehicleData>) {
  return Object.values(records).flatMap((data) => data.events
    .filter((event) => event.transition !== 'recovered')
    .map((event) => {
      const recovery = data.events.find((item) => item.fault_key === event.fault_key &&
        item.transition === 'recovered' && item.occurred_at_ms >= event.occurred_at_ms)
      return {
        id: event.event_id, vehicleId: data.vehicle_id,
        time: new Date(event.occurred_at_ms).toLocaleString('zh-CN', { hour12: false }),
        title: event.message, severity: event.severity === 'ERROR' || event.severity === 'FATAL' ? 'critical' as const : 'warning' as const,
        status: recovery ? 'closed' as const : 'open' as const,
        location: data.profile?.payload.map_id ?? '未知地图',
        description: `${event.fault_key} · ${event.message}`,
        impact: '合成监控事件，不代表真实车辆或执行器状态。',
        cause: 'Mock 场景注入；未执行实车根因诊断。',
        resolution: recovery ? recovery.message : '尚无明确恢复事件，人工知悉不代表恢复。',
        followUp: '仅供监控展示验证，不发送任何车辆命令。',
      }
    }))
}

export function dashboardTasks(records: Record<string, VehicleData>) {
  return Object.values(records).flatMap((data) => data.tasks.map(({ request, result }) => ({
    id: request.request_id, name: `只读账本查询 · ${result?.reason ?? '仅云端落库'}`,
    vehicleId: data.vehicle_id, type: '只读查询 · 非运动任务', priority: '中' as const,
    status: result?.status === 'unknown' ? 'unknown' as const
      : result?.status === 'succeeded' ? 'completed' as const
        : result?.status === 'rejected' ? 'rejected' as const : 'pending' as const,
    plannedStart: new Date(request.created_at_ms).toLocaleString('zh-CN', { hour12: false }),
    createdBy: 'Mock', createdAt: new Date(request.created_at_ms).toLocaleString('zh-CN', { hour12: false }),
    from: request.parameters.target_request_id ?? '未知原请求', to: request.map_id,
  })))
}
