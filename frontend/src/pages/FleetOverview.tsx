import React, { useState } from 'react'
import { Activity, AlertTriangle, Car, Gauge } from 'lucide-react'
import { useMockFleet } from '../app/MockFleetProvider'
import { fleetMetrics, markerColor, overviewVehicle, type OverviewVehicle } from '../lib/fleet-overview'
import { groupVehicleAlerts } from '../lib/vehicle-alerts'
import DevFleetMap from './DevFleetMap'

interface Props {
  selected: string
  onSelect: (id: string, detail?: boolean) => void
  onAlerts: (vehicle?: string) => void
  initialFocus?: { x: number; y: number }
}
const duration = (age: number | null) => age === null ? '未知' : `${(age / 1000).toFixed(1)} s`

export default function FleetOverview({ selected, onSelect, onAlerts, initialFocus }: Props) {
  const mock = useMockFleet()
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<'all' | 'attention' | 'offline'>('all')
  const [focusPosition, setFocusPosition] = useState(initialFocus)
  const map = mock.map
  if (!map) return null
  const now = performance.now()
  const rows = mock.vehicles.entries.map((entry) => overviewVehicle(entry, mock.data[entry.vehicle_id], map, now))
  const metrics = fleetMetrics(rows, mock.data)
  const affected = groupVehicleAlerts(mock.data).filter((group) => group.pending > 0).length
  const target = rows.find((row) => row.id === selected)
  const visible = rows.filter((row) => {
    const match = `${row.id} ${row.name}`.toLowerCase().includes(query.trim().toLowerCase())
    return match && (filter === 'all' || filter === 'offline' && !row.online ||
      filter === 'attention' && (!row.online || row.health !== 'ok' || !row.localizationFresh))
  }).sort((a, b) => {
    const score = (row: OverviewVehicle) => row.health === 'fault' ? 0 : !row.online ? 1 : row.health !== 'ok' ? 2 : 3
    return score(a) - score(b) || a.id.localeCompare(b.id)
  })
  const cards = [
    { label: '在线车辆', value: `${metrics.online} / ${metrics.total}`, detail: `离线 ${metrics.total - metrics.online} 辆`, icon: Car, color: 'text-emerald-300' },
    { label: '自动驾驶', value: metrics.auto, detail: '处于自动驾驶模式，含停车车辆', icon: Gauge, color: 'text-sky-300' },
    { label: '人工驾驶', value: metrics.manual, detail: `驾驶模式未知 ${metrics.unknown} 辆`, icon: Activity, color: 'text-amber-300' },
    { label: '待恢复告警', value: metrics.faults, detail: `${affected} 辆车受影响 · 最近记录，非全量统计`, icon: AlertTriangle, color: 'text-rose-300', action: () => onAlerts() },
  ]
  return <div className="flex h-full min-h-0 flex-col gap-4 overflow-y-auto" data-testid="fleet-overview">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <h1 className="text-base font-semibold">车队总览</h1>
      <span className="rounded-full border border-amber-800 bg-amber-950/30 px-3 py-1 text-[11px] text-amber-200">演示数据 · 非真实车辆</span>
    </div>
    <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
      {cards.map(({ label, value, detail, icon: Icon, color, action }) => <section key={label} title={detail}
        className="rounded-xl border border-slate-800 bg-slate-900/70 px-4 py-3">
        {action ? <button type="button" aria-label="查看待恢复告警" onClick={action} className="w-full text-left">
          <div className="flex items-center justify-between text-xs text-slate-400"><span>{label}</span><Icon className={`h-4 w-4 ${color}`} /></div>
          <p className={`mt-2 text-2xl font-semibold tabular-nums ${color}`}>{value}</p>
          <p className="mt-2 text-[10px] leading-4 text-sky-300">{detail} →</p>
        </button> : <>
        <div className="flex items-center justify-between text-xs text-slate-400"><span>{label}</span><Icon className={`h-4 w-4 ${color}`} /></div>
        <p className={`mt-2 text-2xl font-semibold tabular-nums ${color}`}>{value}</p>
        <p className="mt-2 text-[10px] leading-4 text-slate-500">{detail}</p>
        </>}
      </section>)}
    </div>
    <div className="grid min-h-[640px] grid-cols-1 gap-4 xl:h-[calc(100vh-296px)] xl:grid-cols-[minmax(0,2fr)_minmax(320px,1fr)]">
      <DevFleetMap key={map.id} map={map} rows={visible} selected={selected} focusPosition={focusPosition} onSelect={(id) => onSelect(id)} />
      <section className="flex min-h-0 flex-col overflow-hidden rounded-xl border border-slate-800 bg-slate-900/70">
        <header className="border-b border-slate-800 p-3">
          <div className="flex items-center justify-between"><h2 className="text-sm font-medium">车辆 · 异常优先</h2><span className="text-[11px] text-slate-400">需关注 {metrics.attention} / {metrics.total}</span></div>
          <input aria-label="筛选车队车辆" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索车辆"
            className="mt-3 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-xs text-slate-200 focus:outline-none focus:ring-1 focus:ring-sky-500" />
          <div className="mt-2 flex gap-1 text-[11px]">
            {(['all', 'attention', 'offline'] as const).map((value) => <button key={value} type="button" aria-pressed={filter === value} onClick={() => setFilter(value)}
              className={`rounded px-3 py-1 ${filter === value ? 'bg-sky-900 text-sky-200' : 'text-slate-400 hover:bg-slate-800'}`}>
              {value === 'all' ? '全部' : value === 'attention' ? '需关注' : '离线'}
            </button>)}
            <span className="ml-auto py-1 text-slate-500">{visible.length} 辆</span>
          </div>
        </header>
        <div className="min-h-[180px] flex-1 overflow-y-auto p-2">
          {visible.map((row) => <button type="button" key={row.id} aria-label={`选中 ${row.id}`} aria-pressed={selected === row.id}
            onClick={() => { onSelect(row.id); setFocusPosition(row.position ? { x: row.position.x, y: row.position.y } : undefined) }}
            className={`mb-1 w-full rounded-lg border p-3 text-left ${selected === row.id ? 'border-sky-600 bg-sky-950/30' : 'border-transparent hover:border-slate-700 hover:bg-slate-800/40'}`}>
            <div className="flex items-center justify-between gap-2 text-xs">
              <span className="font-semibold"><span style={{ color: markerColor(row) }}>●</span> {row.id}</span>
              <span className={row.online ? 'text-emerald-300' : 'text-slate-400'}>{row.online ? '在线' : '离线'} · {duration(row.receiptAge)}</span>
            </div>
            <div className="mt-2 flex justify-between gap-2 text-[11px] text-slate-300"><span>{row.modeLabel}</span><span>{row.healthLabel} · {row.gear}</span></div>
            <div className="mt-1 flex justify-between gap-2 text-[10px] text-slate-500"><span>{row.locationReason}</span><span>{row.speed?.toFixed(1) ?? '—'} km/h</span></div>
          </button>)}
          {!visible.length && <p className="p-5 text-center text-xs text-slate-400">没有匹配车辆</p>}
        </div>
        <footer className="border-t border-slate-800 p-3 text-xs">
          {target ? <>
            <div className="flex flex-wrap items-center justify-between gap-2"><strong>{target.id} · 当前选中</strong>
              <div className="flex gap-2"><button type="button" onClick={() => onAlerts(target.id)} className="rounded border border-slate-700 px-2 py-1 text-sky-200">查看告警</button>
                <button type="button" onClick={() => onSelect(target.id, true)} className="rounded border border-sky-700 px-2 py-1 text-sky-200">查看车辆详情</button></div></div>
            <div className="mt-3 grid grid-cols-2 gap-2 text-[11px] text-slate-400">
              <span>{target.speed?.toFixed(1) ?? '—'} km/h · 挡位 {target.gear}</span><span>电量 {target.battery ?? '—'}%</span>
              <span>{target.control}</span><span>{target.sourceAge === null ? '定位更新时间未知' : `定位更新于 ${duration(target.sourceAge)}前`}</span>
            </div>
            <p className="mt-2 text-[10px] text-slate-500">{target.locationReason}</p>
          </> : <p className="text-slate-400">从地图或列表选择车辆。</p>}
        </footer>
      </section>
    </div>
  </div>
}
