import React from 'react'
import type { FleetMap } from '../lib/fleet-map'
import type { OverviewVehicle } from '../lib/fleet-overview'
import VehicleBev from './VehicleBev'
import ThreeCameraView from './ThreeCameraView'

export interface TeleopWorkbenchProps {
  vehicleId: string
  gear: 'P' | 'R' | 'N' | 'D' | '—'
  networkQuality: 0 | 1 | 2 | 3 | 4 | null
  row: OverviewVehicle
  map?: FleetMap
  onBack: () => void
  onMonitor: () => void
  speedKph?: number
  batteryPercent?: number
  runModeLabel?: string
  locationLabel?: string
  authenticated?: boolean
  busy?: boolean
  cameraView?: React.ReactNode
  controlPanel?: React.ReactNode
  videoStatus?: string
  observeOnly?: boolean
}

const TeleopWorkbench: React.FC<TeleopWorkbenchProps> = ({
  vehicleId, gear, row, map, onBack, onMonitor, speedKph, batteryPercent,
  runModeLabel = '模式未知', locationLabel = '位置未知',
  authenticated = false, busy = false, cameraView, controlPanel, videoStatus, observeOnly = false,
}) => (
  <div className="flex h-full min-h-[500px] flex-col gap-4" data-testid="remote-driving-workbench">
    <header className="flex flex-wrap items-center justify-between gap-3">
      <div className="flex flex-wrap items-center gap-3">
        <button type="button" disabled={busy} onClick={onBack} className="rounded border border-slate-700 px-3 py-2 text-xs disabled:opacity-40">返回远程驾驶列表</button>
        <h1 className="text-sm font-semibold text-slate-100">{vehicleId} · 远程驾驶工作台</h1>
        <span className="text-xs text-slate-300">{row.online ? '在线' : '离线'} · {row.control} · 监看模式</span>
        <span className="text-xs text-amber-200">{authenticated ? '远程驾驶' : 'Mock 数据 · 视频未接入 · 不可控制'}</span>
      </div>
      <button type="button" disabled={busy} onClick={onMonitor} className="text-xs text-sky-200 disabled:opacity-40">查看车辆监控</button>
    </header>
    {!row.online && <p role="status" className="text-xs text-amber-300">车辆离线，不能确认当前状态；视频未接入，控制不可用。</p>}
    <dl aria-label="远程驾驶就绪状态" className="flex flex-wrap gap-x-6 gap-y-2 rounded-lg border border-slate-800 bg-slate-900/60 p-3 text-xs">
      {[
        ['遥测', row.online ? authenticated ? '已连接' : 'Mock 正在更新' : '离线 / 未知'], ['视频', videoStatus ?? '未接入'],
        ['网络', '网络质量未知 · 未测量'], ['控制权限', authenticated ? observeOnly ? '仅监看' : '可申请' : '未接入授权检查'],
        ['控制', authenticated ? busy ? '控制会话进行中' : '未申请' : '不可用'],
      ].map(([label, value]) => <div key={label} className="flex gap-2"><dt className="text-slate-500">{label}</dt><dd className="text-slate-300">{value}</dd></div>)}
    </dl>
    {cameraView ?? <ThreeCameraView vehicleId={vehicleId} />}
    {controlPanel}
    <p className="text-xs text-amber-200">{authenticated ? '' : 'Mock 监看 · 不可控制；'}倒挡不改变前三相机方位，不提供后视驾驶。</p>
    <div className="grid gap-3 xl:grid-cols-[minmax(0,1fr)_280px]">
      <section className="rounded-xl border border-slate-800 bg-slate-900/60 p-4 text-xs text-slate-300">
        <p>{vehicleId} · 挡位 {gear} · {runModeLabel}</p>
        <p className="mt-2">车速 {speedKph === undefined ? '未知' : `${speedKph.toFixed(1)} km/h`} · 电量 {batteryPercent === undefined ? '未知' : `${batteryPercent.toFixed(0)}%`}</p>
        <p className="mt-2 text-slate-500">{locationLabel}</p>
      </section>
      {map ? <VehicleBev map={map} row={row} compact />
        : <section className="rounded-xl border border-slate-800 bg-slate-900/60 p-4 text-xs text-slate-400">地图暂不可用</section>}
    </div>
  </div>
)

export default TeleopWorkbench
