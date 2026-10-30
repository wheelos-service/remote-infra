import React, { useEffect, useState } from 'react'
import { AlertTriangle, Car, Clock, Gauge, Radio, Wifi } from 'lucide-react'
import type { VehiclesState } from '../hooks/use-vehicles'
import {
  directoryOnline,
  directoryControl,
  displayTelemetryValue,
  getSampleFreshness,
  type ReceivedVehicle,
  type SampleFreshness,
  type TelemetryFreshnessState,
} from '../lib/vehicle-telemetry'
import type { VehicleDirectoryEntry, VehicleTelemetry } from '../lib/vehicles-api'
import VehicleOperationsPanel from './VehicleOperationsPanel'

interface LiveFleetPageProps {
  mode: 'fleet' | 'monitor'
  vehicles: VehiclesState
  accessToken?: string
  preview?: boolean
}

const freshnessLabels: Record<TelemetryFreshnessState, string> = {
  fresh: '新鲜',
  stale: '过期',
  unknown: '未知',
  'clock-error': '时钟异常',
}

function timeLabel(value: number | null | undefined): string {
  if (value === null || value === undefined) return '未知'
  return new Date(value).toLocaleString()
}

function durationLabel(value: number | null): string {
  if (value === null) return '未知'
  if (value < 1_000) return `${Math.round(value)} ms`
  return `${(value / 1_000).toFixed(1)} s`
}

function occupancyLabel(control: VehicleDirectoryEntry['control']): string {
  if (control.status === 'free') return '空闲'
  if (control.status === 'unknown') return '未知'
  return control.is_self ? '当前操作员占用' : '其他操作员占用'
}

function onlineLabel(entry: ReceivedVehicle, requestFailed: boolean, nowMs: number): string {
  return directoryOnline(entry, requestFailed, nowMs) ? '在线' : '离线'
}

const LiveFleetPage: React.FC<LiveFleetPageProps> = ({ mode, vehicles, accessToken, preview = false }) => {
  const [selectedVehicleId, setSelectedVehicleId] = useState('')
  const [nowMs, setNowMs] = useState(() => performance.now())

  useEffect(() => {
    const timer = window.setInterval(() => setNowMs(performance.now()), 1_000)
    return () => window.clearInterval(timer)
  }, [])

  useEffect(() => {
    if (
      vehicles.status === 'signed-out' ||
      vehicles.status === 'loading' ||
      !vehicles.entries.some((entry) => entry.vehicle_id === selectedVehicleId)
    ) {
      setSelectedVehicleId(vehicles.entries[0]?.vehicle_id ?? '')
    }
  }, [selectedVehicleId, vehicles.entries, vehicles.status])

  const selected = vehicles.entries.find((entry) => entry.vehicle_id === selectedVehicleId)
  const onlineCount = vehicles.entries.filter((entry) =>
    directoryOnline(entry, vehicles.requestFailed, nowMs),
  ).length
  const occupiedCount = vehicles.entries.filter(
    (entry) => directoryControl(entry, vehicles.requestFailed, nowMs).status === 'occupied',
  ).length

  return (
    <div className="flex h-full min-h-0 flex-col gap-4 overflow-y-auto">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold text-slate-100">
            {mode === 'fleet' ? '车队总览' : '车辆监控'}
          </h1>
          <p className="mt-1 text-xs text-slate-400">
            {preview
              ? '固定预览场景 · 非实时数据，不会建立视频或控制会话'
              : '授权车辆实时状态 · 只读遥测，不会建立视频或控制会话'}
          </p>
        </div>
        <div className="flex items-center gap-2 rounded-full border border-slate-700 bg-slate-900 px-3 py-1 text-xs text-slate-300">
          <Radio className="h-3.5 w-3.5 text-sky-300" />
          {vehicles.status === 'loading' && (preview ? '预览场景' : '正在读取车辆目录')}
          {vehicles.status === 'ready' && (preview ? '预览场景 · 非实时' : '每 2 秒更新')}
          {vehicles.status === 'error' && '车辆目录请求失败'}
          {vehicles.status === 'signed-out' && '未登录'}
        </div>
      </header>

      {vehicles.error && (
        <div role="alert" className="rounded-lg border border-rose-800/70 bg-rose-950/40 px-4 py-3 text-sm text-rose-200">
          <div className="flex items-center gap-2 font-medium">
            <AlertTriangle className="h-4 w-4" />
            车辆目录不可用
          </div>
          <p className="mt-1 text-xs text-rose-200/80">{vehicles.error}</p>
          {vehicles.entries.length > 0 && (
            <p className="mt-1 text-xs text-rose-200/70">
              暂留上次读数供查看；本次请求失败期间不标记任何车辆在线。
            </p>
          )}
        </div>
      )}

      {vehicles.status === 'signed-out' && (
        <div className="rounded-xl border border-slate-800 bg-slate-900/70 p-6 text-sm text-slate-300">
          请先从页面右上角登录，以读取当前账号获授权的车辆。
        </div>
      )}

      {mode === 'fleet' && (
        <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
          <SummaryCard icon={<Car className="h-4 w-4 text-sky-300" />} label="授权车辆" value={vehicles.entries.length} />
          <SummaryCard icon={<Wifi className="h-4 w-4 text-emerald-300" />} label="在线" value={onlineCount} />
          <SummaryCard icon={<Radio className="h-4 w-4 text-amber-300" />} label="远程操作占用" value={occupiedCount} />
        </div>
      )}

      <div className="grid min-h-[420px] flex-1 gap-4 xl:grid-cols-[minmax(280px,0.8fr)_minmax(0,1.8fr)]">
        <section className="flex min-h-0 flex-col overflow-hidden rounded-xl border border-slate-800 bg-slate-900/70">
          <div className="flex items-center justify-between border-b border-slate-800 px-4 py-3">
            <h2 className="text-sm font-medium text-slate-100">授权车辆目录</h2>
            <span className="text-xs text-slate-500">{vehicles.entries.length} 辆</span>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto">
            {vehicles.entries.map((entry) => {
              const isSelected = entry.vehicle_id === selectedVehicleId
              const isOnline = directoryOnline(entry, vehicles.requestFailed, nowMs)
              return (
                <button
                  key={entry.vehicle_id}
                  type="button"
                  onClick={() => setSelectedVehicleId(entry.vehicle_id)}
                  aria-pressed={isSelected}
                  className={[
                    'w-full border-b border-slate-800/80 px-4 py-3 text-left hover:bg-slate-800/60',
                    isSelected ? 'bg-slate-800/70' : '',
                  ].join(' ')}
                >
                  <div className="flex items-center justify-between gap-3">
                    <span className="truncate text-sm font-medium text-slate-100">
                      {entry.name || entry.vehicle_id}
                    </span>
                    <span className={isOnline ? 'text-xs text-emerald-300' : 'text-xs text-slate-400'}>
                      {onlineLabel(entry, vehicles.requestFailed, nowMs)}
                    </span>
                  </div>
                  <div className="mt-1 flex items-center justify-between gap-2 text-[11px] text-slate-400">
                    <span>{entry.vehicle_id}</span>
                    <span>操作占用：{occupancyLabel(directoryControl(entry, vehicles.requestFailed, nowMs))}</span>
                  </div>
                </button>
              )
            })}
            {vehicles.entries.length === 0 && (
              <div className="p-5 text-sm text-slate-400">
                {vehicles.status === 'loading'
                  ? '正在载入车辆目录…'
                  : vehicles.status === 'ready'
                    ? '当前账号没有已注册且获授权的车辆。'
                    : '暂无车辆目录数据。'}
              </div>
            )}
          </div>
          <p className="border-t border-slate-800 px-4 py-2 text-[11px] text-slate-500">
            占用状态表示远程操作会话占用，不代表车辆当前输入动作。
          </p>
        </section>

        {selected ? (
          <VehicleDetails
            entry={selected}
            requestFailed={vehicles.requestFailed}
            nowMs={nowMs}
            accessToken={accessToken}
            preview={preview}
          />
        ) : (
          <section className="flex items-center justify-center rounded-xl border border-dashed border-slate-700 bg-slate-900/40 p-6 text-center text-sm text-slate-500">
            选择一辆授权车辆查看遥测详情。
          </section>
        )}
      </div>
      <footer className="text-[11px] text-slate-500">
        {vehicles.updatedAtWallMs
          ? `最近收到目录响应：${timeLabel(vehicles.updatedAtWallMs)}`
          : '尚未收到目录响应'}
      </footer>
    </div>
  )
}

const SummaryCard: React.FC<{ icon: React.ReactNode; label: string; value: number }> = ({
  icon,
  label,
  value,
}) => (
  <div className="flex items-center gap-3 rounded-xl border border-slate-800 bg-slate-900/70 px-4 py-3">
    <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-slate-800">{icon}</div>
    <div>
      <div className="text-xs text-slate-400">{label}</div>
      <div className="text-lg font-semibold text-slate-100">{value}</div>
    </div>
  </div>
)

const VehicleDetails: React.FC<{
  entry: ReceivedVehicle
  requestFailed: boolean
  nowMs: number
  accessToken?: string
  preview: boolean
}> = ({ entry, requestFailed, nowMs, accessToken, preview }) => {
  const state = entry.state
  const chassis = state?.chassis.message
  const localization = state?.localization.message
  const chassisFreshness = getSampleFreshness(state?.chassis, entry, nowMs)
  const localizationFreshness = getSampleFreshness(state?.localization, entry, nowMs)
  const isOnline = directoryOnline(entry, requestFailed, nowMs)
  const control = directoryControl(entry, requestFailed, nowMs)

  return (
    <section className="flex min-h-0 flex-col gap-3 overflow-y-auto rounded-xl border border-slate-800 bg-slate-900/70 p-4">
      <header className="flex flex-wrap items-start justify-between gap-3 border-b border-slate-800 pb-3">
        <div>
          <h2 className="text-base font-semibold text-slate-100">{entry.name || entry.vehicle_id}</h2>
          <p className="mt-1 text-xs text-slate-400">{entry.vehicle_id}</p>
        </div>
        <div className="flex flex-wrap gap-2 text-xs">
          <StatusBadge label={onlineLabel(entry, requestFailed, nowMs)} active={isOnline} />
          <StatusBadge label={`操作占用：${occupancyLabel(control)}`} active={control.status === 'occupied'} />
        </div>
      </header>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Metric label="车速" icon={<Gauge className="h-3.5 w-3.5" />} value={
          chassis?.speed_mps == null
            ? '未知'
            : `${displayTelemetryValue(chassis.speed_mps * 3.6)} km/h`
        } detail={chassis?.speed_mps == null ? undefined : `${displayTelemetryValue(chassis.speed_mps)} m/s`} />
        <Metric label="档位" value={gearLabel(chassis?.gear_location)} />
        <Metric label="驾驶模式" value={drivingModeLabel(chassis?.driving_mode)} />
        <Metric label="电池 SOC" value={
          chassis?.battery_soc_percentage == null
            ? '未知'
            : `${displayTelemetryValue(chassis.battery_soc_percentage)}%`
        } />
        <Metric label="转向百分比" value={
          chassis?.steering_percentage == null
            ? '未知'
            : `${displayTelemetryValue(chassis.steering_percentage)}%`
        } />
        <Metric label="驻车制动" value={
          chassis?.parking_brake == null ? '未知' : chassis.parking_brake ? '已启用' : '未启用'
        } />
        <Metric label="遥测序列" value={state ? String(state.sequence) : '未知'} />
        <Metric label="数据流" value={state?.stream_id ?? '未知'} />
      </div>

      <section className="rounded-lg border border-slate-800 bg-slate-950/50 p-3">
        <h3 className="mb-2 text-xs font-medium text-slate-200">定位坐标（车辆坐标系）</h3>
        <div className="grid grid-cols-2 gap-2 text-xs sm:grid-cols-4">
          <Coordinate label="X" value={localization?.position?.x} />
          <Coordinate label="Y" value={localization?.position?.y} />
          <Coordinate label="Z" value={localization?.position?.z} />
          <Coordinate label="航向" value={localization?.heading_rad} unit="rad" />
        </div>
        <p className="mt-2 text-[11px] text-slate-500">
          坐标单位：米；坐标系 {localization?.frame_id || '未知'}。未进行地理投影。
        </p>
      </section>

      <section className="grid gap-3 md:grid-cols-2">
        <FreshnessCard
          title="底盘样本"
          sample={state?.chassis}
          freshness={chassisFreshness}
        />
        <FreshnessCard
          title="定位样本"
          sample={state?.localization}
          freshness={localizationFreshness}
        />
      </section>

      <section className="grid gap-2 rounded-lg border border-slate-800 bg-slate-950/50 p-3 text-xs sm:grid-cols-2">
        <Timestamp icon={<Clock className="h-3.5 w-3.5" />} label="采样发布" value={timeLabel(state?.published_at_ms)} />
        <Timestamp icon={<Clock className="h-3.5 w-3.5" />} label="服务端接收" value={timeLabel(entry.received_at_ms)} />
        <Timestamp icon={<Clock className="h-3.5 w-3.5" />} label="服务端当前时间" value={timeLabel(entry.server_time_ms)} />
        <Timestamp icon={<Clock className="h-3.5 w-3.5" />} label="浏览器收到响应" value={timeLabel(entry.receivedAtWallMs)} />
      </section>

      {!state && (
        <p className="text-xs text-slate-500">尚无遥测快照；缺少数据不会解释为正常状态。</p>
      )}

      <VehicleOperationsPanel
        key={`${preview ? 'preview' : 'live'}:${entry.vehicle_id}`}
        vehicleId={entry.vehicle_id}
        accessToken={accessToken}
        preview={preview}
      />
    </section>
  )
}

const StatusBadge: React.FC<{ label: string; active: boolean }> = ({ label, active }) => (
  <span
    className={[
      'rounded-full border px-2.5 py-1',
      active
        ? 'border-emerald-700/70 bg-emerald-950/40 text-emerald-200'
        : 'border-slate-700 bg-slate-950/50 text-slate-300',
    ].join(' ')}
  >
    {label}
  </span>
)

const Metric: React.FC<{
  label: string
  value: string
  detail?: string
  icon?: React.ReactNode
}> = ({ label, value, detail, icon }) => (
  <div className="rounded-lg border border-slate-800 bg-slate-950/50 p-3">
    <div className="flex items-center gap-1.5 text-[11px] text-slate-400">
      {icon}
      {label}
    </div>
    <div className="mt-1 break-words text-sm font-medium text-slate-100">{value}</div>
    {detail && <div className="mt-0.5 text-[11px] text-slate-500">{detail}</div>}
  </div>
)

const Coordinate: React.FC<{ label: string; value: number | null | undefined; unit?: string }> = ({
  label,
  value,
  unit = 'm',
}) => (
  <div className="rounded bg-slate-900 px-2 py-1.5">
    <span className="text-slate-500">{label} </span>
    <span className="text-slate-200">
      {value == null ? '未知' : `${displayTelemetryValue(value)} ${unit}`}
    </span>
  </div>
)

const FreshnessCard: React.FC<{
  title: string
  sample: VehicleTelemetry['chassis'] | VehicleTelemetry['localization'] | undefined
  freshness: SampleFreshness
}> = ({ title, sample, freshness }) => (
  <div className="rounded-lg border border-slate-800 bg-slate-950/50 p-3">
    <div className="flex items-center justify-between gap-2">
      <h3 className="text-xs font-medium text-slate-200">{title}新鲜度</h3>
      <span className="text-xs text-slate-300">{freshnessLabels[freshness.state]}</span>
    </div>
    <dl className="mt-2 grid grid-cols-2 gap-2 text-[11px]">
      <div>
        <dt className="text-slate-500">请求起经过（含往返上界）</dt>
        <dd className="mt-0.5 text-slate-300">{durationLabel(freshness.receiptAgeMs)}</dd>
      </div>
      <div>
        <dt className="text-slate-500">保守最大样本年龄</dt>
        <dd className="mt-0.5 text-slate-300">{durationLabel(freshness.sourceAgeMs)}</dd>
      </div>
      <div>
        <dt className="text-slate-500">回调年龄</dt>
        <dd className="mt-0.5 text-slate-300">{durationLabel(freshness.callbackAgeMs)}</dd>
      </div>
      <div>
        <dt className="text-slate-500">服务端快照年龄</dt>
        <dd className="mt-0.5 text-slate-300">{durationLabel(freshness.gatewayStateAgeMs)}</dd>
      </div>
      <div>
        <dt className="text-slate-500">发布至服务端年龄</dt>
        <dd className="mt-0.5 text-slate-300">{durationLabel(freshness.publisherTransitAgeMs)}</dd>
      </div>
      <div>
        <dt className="text-slate-500">源时间戳</dt>
        <dd className="mt-0.5 text-slate-300">{timeLabel(sample?.source_timestamp_ms)}</dd>
      </div>
      <div>
        <dt className="text-slate-500">源序号</dt>
        <dd className="mt-0.5 text-slate-300">{sample?.source_sequence ?? '未知'}</dd>
      </div>
    </dl>
    {freshness.state === 'clock-error' && (
      <p className="mt-2 text-[11px] text-amber-300">源时间戳、发布或服务端接收时间与服务端时钟不兼容，无法可靠判断新鲜度。</p>
    )}
  </div>
)

const Timestamp: React.FC<{ icon: React.ReactNode; label: string; value: string }> = ({
  icon,
  label,
  value,
}) => (
  <div className="flex min-w-0 items-center gap-2">
    <span className="text-slate-500">{icon}</span>
    <span className="shrink-0 text-slate-500">{label}</span>
    <span className="truncate text-slate-300" title={value}>{value}</span>
  </div>
)

function gearLabel(value: string | null | undefined): string {
  const labels: Record<string, string> = {
    GEAR_NEUTRAL: '空挡',
    GEAR_DRIVE: '前进',
    GEAR_REVERSE: '倒车',
    GEAR_PARKING: '驻车',
    GEAR_LOW: '低速',
    GEAR_INVALID: '无效',
    GEAR_NONE: '无',
  }
  return value ? labels[value] ?? value : '未知'
}

function drivingModeLabel(value: string | null | undefined): string {
  const labels: Record<string, string> = {
    COMPLETE_MANUAL: '完全手动',
    COMPLETE_AUTO_DRIVE: '完全自动驾驶',
    AUTO_STEER_ONLY: '仅自动转向',
    AUTO_SPEED_ONLY: '仅自动速度',
    EMERGENCY_MODE: '紧急模式',
  }
  return value ? labels[value] ?? value : '未知'
}

export default LiveFleetPage
