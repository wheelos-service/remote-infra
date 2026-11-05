import React, { useEffect, useRef, useState } from 'react'
import { ArrowLeft, ArrowUpRight, Camera, Search } from 'lucide-react'
import { useMockFleet } from '../app/MockFleetProvider'
import { overviewVehicle, type OverviewVehicle } from '../lib/fleet-overview'
import { groupVehicleAlerts, pendingAlertCount, severityLabel, type VehicleAlertGroup } from '../lib/vehicle-alerts'
import { vehicleHealthChecks, type MonitorListState } from '../lib/vehicle-monitor'
import type { ReceivedVehicle } from '../lib/vehicle-telemetry'
import type { VehicleData } from '../lib/vehicle-data-api'
import type { FleetMap } from '../lib/fleet-map'
import VehicleBev from './VehicleBev'

interface Props {
  selected: string
  mode: 'list' | 'detail'
  list: MonitorListState
  onListChange: (list: MonitorListState) => void
  onModeChange: (mode: 'list' | 'detail') => void
  onSelect: (id: string) => void
  onDrive: (id: string) => void
  onAlerts: (id: string) => void
}
const duration = (age: number | null) => age === null ? '未知' : `${(age / 1000).toFixed(1)} 秒前`
const time = (value: number) => new Date(value).toLocaleString('zh-CN', { hour12: false })
const statusClass = (status: string) => status === 'FATAL' || status === 'ERROR' ? 'text-rose-300' : status === 'WARN' ? 'text-amber-300'
  : status === 'OK' ? 'text-emerald-300' : 'text-slate-400'

export default function VehicleMonitor({ selected, mode, list, onListChange, onModeChange, onSelect, onDrive, onAlerts }: Props) {
  const mock = useMockFleet()
  const scroll = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (mode === 'list' && scroll.current) scroll.current.scrollTop = list.scrollTop
  }, [mode, list.query, list.filter])
  const map = mock.map
  if (!map) return null
  const now = performance.now()
  const rows = mock.vehicles.entries.map((entry) => overviewVehicle(entry, mock.data[entry.vehicle_id], map, now))
  const groups = groupVehicleAlerts(mock.data)
  const visible = rows.filter((row) => `${row.id} ${row.name}`.toLowerCase().includes(list.query.trim().toLowerCase()) &&
    (list.filter === 'all' || list.filter === 'offline' && !row.online || list.filter === 'alerts' && pendingAlertCount(mock.data[row.id]) > 0))
  const row = rows.find((value) => value.id === selected)
  const entry = mock.vehicles.entries.find((value) => value.vehicle_id === selected)
  const show = (id: string) => { onSelect(id); onModeChange('detail') }
  if (mode === 'detail' && (!row || !entry)) return <section role="alert" className="space-y-4 p-4">
    <p>车辆 {selected} 已不在当前车辆目录中，无法查看详情。</p>
    <button type="button" onClick={() => onModeChange('list')} className="text-sky-300">返回车辆列表</button>
  </section>
  if (mode === 'detail' && row && entry) return <VehicleMonitorDetail key={`${map.id}:${row.id}`} row={row} entry={entry} data={mock.data[row.id]}
    map={map} group={groups.find((value) => value.vehicleId === row.id)} onBack={() => onModeChange('list')} onDrive={() => onDrive(row.id)}
    onAlerts={() => onAlerts(row.id)} />
  return <VehicleMonitorList rows={rows} list={list} onListChange={onListChange} onSelect={show} onAlerts={onAlerts} groups={groups} visibleRows={visible} />
}

export function VehicleMonitorList({ rows, list, onListChange, onSelect: show, onAlerts, groups = [], visibleRows, authenticated = false, canObserve = true }: {
  rows: OverviewVehicle[]; list: MonitorListState; onListChange: Props['onListChange']; onSelect: Props['onSelect'];
  onAlerts: Props['onAlerts']; groups?: VehicleAlertGroup[]; visibleRows?: OverviewVehicle[]; authenticated?: boolean; canObserve?: boolean
}) {
  const scroll = useRef<HTMLDivElement>(null)
  useEffect(() => { if (scroll.current) scroll.current.scrollTop = list.scrollTop }, [list.query, list.filter])
  const visible = visibleRows ?? rows.filter(row => `${row.id} ${row.name}`.toLowerCase().includes(list.query.trim().toLowerCase()) &&
    (list.filter === 'all' || list.filter === 'offline' && !row.online))
  return <div className="flex h-full min-h-0 flex-col gap-4" data-testid="vehicle-monitor-list">
    <header className="flex flex-wrap items-center justify-between gap-2">
      <h1 className="text-base font-semibold">车辆监控</h1>
      <span className="text-xs text-slate-400">共 {rows.length} 辆 · 在线 {rows.filter((value) => value.online).length} 辆</span>
    </header>
    <div className="flex flex-wrap items-center gap-3">
      <label className="relative min-w-[220px] flex-1">
        <Search className="absolute left-3 top-2.5 h-4 w-4 text-slate-500" aria-hidden="true" />
        <input aria-label="搜索监控车辆" value={list.query} onChange={(event) => onListChange({ ...list, query: event.target.value, scrollTop: 0 })}
          placeholder="搜索车辆编号或名称" className="w-full rounded-lg border border-slate-700 bg-slate-900 py-2 pl-9 pr-3 text-xs focus:outline-none focus:ring-1 focus:ring-sky-500" />
      </label>
      <div role="group" aria-label="车辆列表筛选" className="flex gap-1 text-xs">
        {(['all', 'alerts', 'offline'] as const).map((filter) => <button key={filter} type="button" aria-pressed={list.filter === filter} disabled={authenticated && filter === 'alerts'}
          onClick={() => onListChange({ ...list, filter, scrollTop: 0 })}
          className={`rounded px-3 py-2 ${list.filter === filter ? 'bg-sky-900 text-sky-200' : 'bg-slate-900 text-slate-400'}`}>
          {filter === 'all' ? '全部' : filter === 'alerts' ? '有告警' : '离线'}
        </button>)}
      </div>
    </div>
    <section className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-slate-800 bg-slate-900/70">
      <header className="flex items-center justify-between border-b border-slate-800 p-3 text-xs"><h2>车辆列表</h2><span className="text-slate-500">显示 {visible.length} 辆</span></header>
      <div ref={scroll} onScroll={(event) => {
        const scrollTop = event.currentTarget.scrollTop
        if (scrollTop !== list.scrollTop) onListChange({ ...list, scrollTop })
      }} className="max-h-[calc(100vh-250px)] min-h-0 flex-1 overflow-auto">
        <div className="min-w-[760px]">
          <div className="grid grid-cols-[minmax(160px,2fr)_1fr_1fr_1fr_1fr_80px_100px] gap-3 border-b border-slate-800 bg-slate-950/50 px-4 py-3 text-[11px] text-slate-500">
            {['车辆', '连接', '驾驶模式', '运行状态', '告警', '电量', '最近更新'].map((label) => <span key={label}>{label}</span>)}
          </div>
          {visible.map((value) => {
            const group = groups.find((item) => item.vehicleId === value.id)
            return <div key={value.id} onClick={() => { if (canObserve) show(value.id) }}
              className="grid w-full cursor-pointer grid-cols-[minmax(160px,2fr)_1fr_1fr_1fr_1fr_80px_100px] items-center gap-3 border-b border-slate-800 px-4 py-4 text-left text-xs hover:bg-slate-800/50 focus-within:bg-slate-800/50">
              <button type="button" disabled={!canObserve} aria-label={`查看车辆 ${value.id}`} className="min-w-0 text-left disabled:opacity-40"><strong>{value.id}</strong><span className="mt-1 block truncate text-[10px] text-slate-500">{value.name.replace(`${value.id} · `, '')}</span></button>
              <span className={value.online ? 'text-emerald-300' : 'text-slate-400'}>{value.online ? '在线' : '离线'}</span>
              <span>{value.modeLabel}</span>
              <span>{value.speed === null ? '状态未知' : Math.abs(value.speed) < 0.1 ? '停车' : '行驶'}<span className="mt-1 block text-[10px] text-slate-500">{value.speed?.toFixed(1) ?? '—'} km/h</span></span>
              <button type="button" aria-label={`查看 ${value.id} 告警`} onClick={(event) => { event.stopPropagation(); onAlerts(value.id) }}
                className={`text-left hover:underline ${group?.pending ? statusClass(group.severity) : 'text-slate-400'}`}>
                {authenticated ? '未接入' : group?.pending ? `${severityLabel(group.severity)} · ${group.pending} 项` : '记录中无待恢复告警'}
              </button>
              <span className={value.battery !== null && value.battery < 20 ? 'text-amber-300' : 'text-slate-300'}>{value.battery === null ? '未知' : `${value.battery}%`}</span>
              <span className="text-[11px] text-slate-400">{duration(value.receiptAge)}</span>
            </div>
          })}
          {!visible.length && <p className="p-8 text-center text-xs text-slate-500">没有匹配车辆</p>}
        </div>
      </div>
    </section>
  </div>
}

interface DetailProps {
  row: OverviewVehicle
  entry: ReceivedVehicle
  data: VehicleData | undefined
  group: VehicleAlertGroup | undefined
  onBack: () => void
  onDrive: () => void
  onAlerts: () => void
  map?: FleetMap
  cameraView?: React.ReactNode
  authenticated?: boolean
  dataError?: string
  dataLoading?: boolean
}
export function VehicleMonitorDetail({ row, entry, data, group, onBack, onDrive, onAlerts, map, cameraView, authenticated = false, dataError, dataLoading }: DetailProps) {
  const [tab, setTab] = useState('realtime')
  const checks = vehicleHealthChecks(entry, data, performance.now())
  const pending = group?.pending ?? 0
  const profile = data?.profile
  const profileAge = profile ? Math.max(0, (data?.server_time_ms ?? 0) - profile.received_at_ms) + Math.max(0, performance.now() - entry.receivedAtClientMs) : null
  return <div className="flex h-full min-h-0 flex-col gap-4 overflow-y-auto" data-testid="vehicle-monitor-detail">
    <header className="flex flex-wrap items-center justify-between gap-3">
      <div className="flex flex-wrap items-center gap-3">
        <button type="button" onClick={onBack} className="flex items-center gap-1 rounded border border-slate-700 px-2 py-1.5 text-xs text-slate-300"><ArrowLeft className="h-3 w-3" />返回车辆列表</button>
        <h1 className="text-base font-semibold">{row.id}</h1>
        <span className={`text-xs ${row.online ? 'text-emerald-300' : 'text-slate-400'}`}>{row.online ? '在线' : '离线'}</span>
        <span className="text-xs text-slate-300">{row.modeLabel}</span>
        <button type="button" onClick={onAlerts} className={`text-xs ${pending ? 'text-amber-300' : 'text-slate-400'}`}>{authenticated && !data ? '告警数据暂不可用' : `待恢复告警 ${pending}`}{pending && group ? ` · 最高${severityLabel(group.severity)}` : ''} · 查看告警 →</button>
      </div>
    </header>
    <nav aria-label="车辆详情页签" className="flex gap-1 overflow-x-auto border-b border-slate-800">
      {([
        ['realtime', '实时'], ['health', '健康状态'], ['profile', '车辆信息'],
      ] as const).map(([value, label]) => <button key={value} type="button" aria-current={tab === value ? 'page' : undefined} onClick={() => setTab(value)}
        className={`whitespace-nowrap border-b-2 px-4 py-2.5 text-xs ${tab === value ? 'border-sky-400 text-sky-200' : 'border-transparent text-slate-400 hover:text-slate-200'}`}>{label}</button>)}
    </nav>
    {dataError && <p role="alert" className="text-xs text-red-300">{dataError}</p>}
    {dataLoading && <p role="status" className="text-xs text-slate-400">正在加载车辆数据…</p>}
    {tab === 'realtime' && <>
      <div className="grid gap-4 xl:min-h-[380px] xl:grid-cols-[minmax(0,2fr)_minmax(300px,1fr)]">
        <section className="flex min-w-0 flex-col overflow-hidden rounded-xl border border-slate-800 bg-slate-900/70">
          <header className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-800 p-3">
            <h2 className="flex items-center gap-2 text-sm"><Camera className="h-4 w-4 text-slate-400" />前视相机</h2>
            <button type="button" onClick={onDrive} className="inline-flex items-center gap-2 text-xs text-sky-200">进入远程驾驶<ArrowUpRight className="h-4 w-4" /></button>
          </header>
          <div className="relative min-h-[300px] flex-1 bg-slate-950">
            {cameraView ?? <div className="flex min-h-[300px] items-center justify-center text-xs text-slate-500">未接入实时视频</div>}
          </div>
        </section>
        {map ? <VehicleBev key={`${map.id}:${row.id}`} map={map} row={row} />
          : <section className="flex flex-col rounded-xl border border-slate-800 bg-slate-900/70">
            <h2 className="border-b border-slate-800 p-3 text-sm">BEV / 地图</h2>
            <p className="flex flex-1 items-center justify-center p-8 text-xs text-slate-500">地图暂不可用</p>
          </section>}
      </div>
      <section className="grid grid-cols-2 gap-3 xl:grid-cols-5">
        {[
          ['速度', `${row.speed?.toFixed(1) ?? '—'} km/h`], ['挡位', row.gear],
          ['电量', row.battery === null ? '未知' : `${row.battery}%`], ['定位状态', row.locationReason], ['数据更新', duration(row.receiptAge)],
        ].map(([label, value]) => <div key={label} className="rounded-xl border border-slate-800 bg-slate-900/70 p-3">
          <p className="text-[11px] text-slate-500">{label}</p><p className={`mt-2 text-sm ${label === '定位状态' && (!row.localizationFresh || !row.position) ? 'text-amber-300' : 'text-slate-200'}`}>{value}</p>
        </div>)}
      </section>
    </>}
    {tab === 'health' && <section className="overflow-hidden rounded-xl border border-slate-800 bg-slate-900/70">
      <header className="border-b border-slate-800 p-4"><h2 className="text-sm font-medium">健康检查</h2>
        <p className="mt-2 text-[11px] text-slate-500">展示设备已有检查结果，异常优先；未运行主动远程诊断。</p></header>
      <ul className="divide-y divide-slate-800">{checks.map((check) => <li key={check.key} className="p-4">
        <div className="flex flex-wrap items-center justify-between gap-2 text-xs"><strong>{check.label}</strong>
          <span className={statusClass(check.status)}>{check.status === 'OK' ? '已采集项正常' : check.status === 'UNKNOWN' ? '未知 / 不可确认' : severityLabel(check.status)}</span></div>
        <p className="mt-2 break-words text-xs text-slate-400">{check.detail}</p><p className="mt-2 text-[10px] text-slate-500">数据更新 {duration(check.age)}</p>
      </li>)}</ul>
    </section>}
    {tab === 'profile' && <section className="rounded-xl border border-slate-800 bg-slate-900/70 p-4">
      <h2 className="text-sm font-medium">车辆信息</h2>
      <dl className="mt-4 grid grid-cols-1 gap-4 text-xs md:grid-cols-2">
        {[
          ['车辆编号', row.id], ['车辆名称', row.name], ['车型', profile?.payload.model ?? '未提供'],
          ['软件版本', profile?.payload.software_version ?? '未提供'], ['地图版本 / 标识', profile?.payload.map_id ?? '未提供'],
          ['资料更新', profile ? `${time(profile.received_at_ms)} · ${duration(profileAge)}` : '未提供'],
        ].map(([label, value]) => <div key={label} className="min-w-0"><dt className="text-slate-500">{label}</dt><dd className="mt-2 break-words text-slate-200">{value}</dd></div>)}
      </dl>
      <p className="mt-5 border-t border-slate-800 pt-3 text-[11px] text-slate-500">硬件配置和维护资料尚未接入。配置资料不代表设备当前健康状态。</p>
    </section>}
  </div>
}
