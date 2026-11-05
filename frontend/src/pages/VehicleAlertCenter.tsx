import React, { useState } from 'react'
import { ArrowLeft, Search } from 'lucide-react'
import { useMockFleet } from '../app/MockFleetProvider'
import { overviewVehicle } from '../lib/fleet-overview'
import {
  alertStateLabel, filterVehicleAlerts, groupVehicleAlerts, initialAlertFilters, severityLabel,
  type AlertFilters, type AlertSection, type AlertSeverity,
} from '../lib/vehicle-alerts'
import AlertDashboard from './AlertDashboard'
import VehicleAlertTimeline from './VehicleAlertTimeline'

interface Props {
  filters: AlertFilters
  section: AlertSection
  onSection: (section: AlertSection) => void
  onChange: (filters: AlertFilters) => void
  onNavigate: (vehicle: string) => void
}
const time = (value: number) => new Date(value).toLocaleString('zh-CN', { hour12: false })
const severityClass = (severity: AlertSeverity) => severity === 'FATAL' ? 'border-red-500/60 bg-red-950/60 text-red-200'
  : severity === 'ERROR' ? 'border-rose-700 bg-rose-950/40 text-rose-200'
    : severity === 'WARN' ? 'border-amber-700 bg-amber-950/40 text-amber-200' : 'border-slate-600 text-slate-300'
const age = (value: number) => value < 60_000 ? '不足 1 分钟' : value < 3_600_000 ? `${Math.floor(value / 60_000)} 分钟` : `${Math.floor(value / 3_600_000)} 小时`

function AlertCenterNavigation({ section, onSection }: { section: AlertSection; onSection: (section: AlertSection) => void }) {
  return <nav aria-label="告警中心板块" className="flex gap-1 border-b border-slate-800">
    {([['dashboard', '运营看板'], ['work', '车辆处置'], ['history', '历史记录']] as const).map(([value, label]) =>
      <button key={value} type="button" aria-current={section === value ? 'page' : undefined} onClick={() => onSection(value)}
        className={`border-b-2 px-4 py-2.5 text-sm ${section === value ? 'border-sky-400 text-sky-200' : 'border-transparent text-slate-400 hover:text-slate-200'}`}>{label}</button>)}
  </nav>
}

export function UnavailableVehicleAlertCenter() {
  const [section, setSection] = useState<AlertSection>('dashboard')
  return <div className="flex h-full min-h-0 flex-col gap-4" data-testid="vehicle-alert-center">
    <header><h1 className="text-base font-semibold">告警中心</h1></header>
    <AlertCenterNavigation section={section} onSection={setSection} />
    <section className="flex min-h-[300px] items-center justify-center rounded-xl border border-slate-800 bg-slate-900/70 p-8">
      <p role="status" className="text-sm text-slate-400">告警数据暂不可用</p>
    </section>
  </div>
}

export default function VehicleAlertCenter({ filters, section, onSection, onChange, onNavigate }: Props) {
  const mock = useMockFleet()
  const names = Object.fromEntries(mock.vehicles.entries.map((entry) => [entry.vehicle_id, entry.name]))
  const groups = groupVehicleAlerts(mock.data, names)
  const now = Math.max(0, ...Object.values(mock.data).map((data) => data.server_time_ms))
  const visible = filterVehicleAlerts(groups, filters, now)
  const selected = filters.selectedVehicle ? visible.find((group) => group.vehicleId === filters.selectedVehicle) : visible[0]
  const fullGroup = groups.find((group) => group.vehicleId === selected?.vehicleId)
  const exactMatch = selected?.alerts.find((alert) => alert.events.some((event) => event.event_id.toLowerCase() === filters.query.trim().toLowerCase()))
  const alert = exactMatch ?? selected?.alerts.find((item) => item.id === filters.selectedAlert) ?? selected?.alerts[0]
  const entry = mock.vehicles.entries.find((vehicle) => vehicle.vehicle_id === selected?.vehicleId)
  const vehicle = entry && mock.map ? overviewVehicle(entry, mock.data[entry.vehicle_id], mock.map, performance.now()) : undefined
  const change = (patch: Partial<AlertFilters>) => {
    const filtering = patch.query !== undefined || patch.vehicle !== undefined || patch.state !== undefined ||
      patch.severity !== undefined || patch.period !== undefined
    onChange({ ...filters, ...(filtering ? { selectedVehicle: '', selectedAlert: '' } : {}), ...patch })
  }
  return <div className="flex h-full min-h-0 flex-col gap-4 overflow-y-auto" data-testid="vehicle-alert-center">
    <header className="flex flex-wrap items-center justify-between gap-2">
      <h1 className="text-base font-semibold">告警事件中心</h1>
    </header>
    <AlertCenterNavigation section={section} onSection={value => {
          onSection(value)
          if (value === 'history' && section !== 'history') onChange({ ...filters, state: 'all', selectedAlert: '', selectedVehicle: '' })
        }} />
    {section === 'dashboard' ? <AlertDashboard groups={groups} now={now} onOpen={(next) => {
      onChange(next)
      onSection('work')
    }} /> : <>
    <section className="rounded-xl border border-slate-800 bg-slate-900/70 p-3">
      <div className="flex flex-wrap items-center gap-3">
        <label className="relative min-w-[220px] flex-1">
          <Search className="absolute left-3 top-2.5 h-4 w-4 text-slate-500" aria-hidden="true" />
          <input aria-label="搜索车辆或事件" value={filters.query} onChange={(event) => change({ query: event.target.value })}
            placeholder="搜索车辆、事件编号或告警内容"
            className="w-full rounded-lg border border-slate-700 bg-slate-950 py-2 pl-9 pr-3 text-xs focus:outline-none focus:ring-1 focus:ring-sky-500" />
        </label>
        <label className="flex items-center gap-2 text-xs text-slate-400">车辆
          <select aria-label="告警车辆" value={filters.vehicle} onChange={(event) => change({ vehicle: event.target.value })}
            className="rounded border border-slate-700 bg-slate-950 p-2 text-slate-200">
            <option value="">全部车辆</option>
            {mock.vehicles.entries.map((item) => <option key={item.vehicle_id} value={item.vehicle_id}>{item.vehicle_id}</option>)}
          </select>
        </label>
        <label className="flex items-center gap-2 text-xs text-slate-400">设备状态
          <select aria-label="告警恢复状态" value={filters.state} onChange={(event) => {
            const state = event.target.value
            if (state === 'all' || state === 'pending' || state === 'recovered') change({ state })
          }} className="rounded border border-slate-700 bg-slate-950 p-2 text-slate-200">
            <option value="pending">待恢复（含待确认）</option><option value="recovered">已恢复</option><option value="all">全部状态</option>
          </select>
        </label>
        <label className="flex items-center gap-2 text-xs text-slate-400">严重程度
          <select aria-label="告警严重程度" value={filters.severity} onChange={(event) => {
            const severity = event.target.value
            if (severity === 'all' || severity === 'critical' || severity === 'FATAL' || severity === 'ERROR' || severity === 'WARN') change({ severity })
          }} className="rounded border border-slate-700 bg-slate-950 p-2 text-slate-200">
            <option value="all">全部级别</option><option value="critical">严重及紧急</option><option value="FATAL">紧急</option><option value="ERROR">严重</option><option value="WARN">警告</option>
          </select>
        </label>
        <label className="flex items-center gap-2 text-xs text-slate-400">时间
          <select aria-label="告警时间范围" value={filters.period} onChange={(event) => {
            const period = event.target.value
            if (period === 'retained' || period === '24h') change({ period })
          }} className="rounded border border-slate-700 bg-slate-950 p-2 text-slate-200">
            <option value="retained">已加载记录</option><option value="24h">近24小时有变化</option>
          </select>
        </label>
        <button type="button" onClick={() => onChange({ ...initialAlertFilters, state: 'all' })}
          className="text-xs text-sky-300 hover:text-sky-200">清除筛选</button>
      </div>
      <p className="mt-3 text-[11px] text-slate-500">仅查询已加载记录，非全量历史。设备恢复不等于人工处置完成。</p>
    </section>
    {section === 'history' ? <section className="overflow-hidden rounded-xl border border-slate-800 bg-slate-900/70">
      <header className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-800 p-3">
        <h2 className="text-sm font-medium">告警发生记录</h2><span className="text-[11px] text-slate-500">正式报表及导出将在完整历史接入后提供</span>
      </header>
      <div className="overflow-x-auto">
        <table className="w-full text-left text-xs">
          <thead className="bg-slate-950/60 text-slate-400"><tr>
            {['车辆', '告警', '严重度', '设备状态', '发生时间', '恢复时间', ''].map((label) => <th key={label} className="whitespace-nowrap px-4 py-3 font-normal">{label}</th>)}
          </tr></thead>
          <tbody>{visible.flatMap((group) => group.alerts.map((item) => <tr key={item.id} className="border-t border-slate-800">
            <td className="whitespace-nowrap px-4 py-3 font-medium">{group.vehicleId}</td>
            <td className="min-w-[220px] px-4 py-3"><p>{item.events.at(-1)?.message}</p><p className="mt-1 text-[10px] text-slate-500">{item.events[0]?.event_id}</p></td>
            <td className="whitespace-nowrap px-4 py-3">{severityLabel(item.severity)}</td>
            <td className="whitespace-nowrap px-4 py-3">{alertStateLabel(item.state)}</td>
            <td className="whitespace-nowrap px-4 py-3 text-slate-400">{item.historyIncomplete ? '起点不完整' : time(item.startedAt)}</td>
            <td className="whitespace-nowrap px-4 py-3 text-slate-400">{item.recoveredAt ? time(item.recoveredAt) : '—'}</td>
            <td className="whitespace-nowrap px-4 py-3"><button type="button" aria-label={`查看记录 ${item.id}`} onClick={() => {
              onChange({ ...initialAlertFilters, state: 'all', vehicle: group.vehicleId, selectedVehicle: group.vehicleId, selectedAlert: item.id })
              onSection('work')
            }} className="text-sky-300">查看过程</button></td>
          </tr>))}</tbody>
        </table>
        {!visible.length && <p className="p-8 text-center text-xs text-slate-400">当前条件下无匹配记录，更早记录可能不在已加载范围内。</p>}
      </div>
    </section> : <div className="grid min-h-[600px] grid-cols-1 gap-4 xl:h-[calc(100vh-310px)] xl:grid-cols-[minmax(280px,1fr)_minmax(0,2fr)]">
      <section className="flex min-h-0 flex-col overflow-hidden rounded-xl border border-slate-800 bg-slate-900/70">
        <header className="flex items-center justify-between border-b border-slate-800 p-3 text-xs">
          <h2 className="font-medium">车辆处置队列</h2><span className="text-slate-400">匹配 {visible.length} 辆 · {visible.reduce((sum, group) => sum + group.alerts.length, 0)} 项</span>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto p-2">
          {visible.map((group) => <button type="button" key={group.vehicleId} aria-label={`查看 ${group.vehicleId} 告警`}
            aria-pressed={selected?.vehicleId === group.vehicleId} onClick={() => change({ selectedVehicle: group.vehicleId, selectedAlert: '' })}
            className={`mb-2 w-full rounded-lg border p-3 text-left ${selected?.vehicleId === group.vehicleId ? 'border-sky-600 bg-sky-950/30' : 'border-slate-800 hover:border-slate-600'}`}>
            <div className="flex items-center justify-between gap-2"><strong className="text-sm">{group.vehicleId}</strong>
              <span className={`rounded border px-2 py-0.5 text-[10px] ${severityClass(group.severity)}`}>{severityLabel(group.severity)}</span></div>
            <p className="mt-2 text-xs text-slate-300">全车待恢复 {group.pending} 项 · 当前匹配 {group.alerts.length} 项</p>
            <p className="mt-2 line-clamp-2 text-[11px] leading-5 text-slate-400">{group.alerts.map((item) => item.events.at(-1)?.message).join('；')}</p>
            <p className="mt-2 text-[11px] text-slate-400">责任人：暂未接入</p>
            <p className="mt-2 text-[10px] text-slate-500">最近变化 {time(group.updatedAt)}</p>
          </button>)}
          {!visible.length && <p className="p-6 text-center text-xs leading-6 text-slate-400">当前条件下无匹配记录。<br />可清除筛选或查询全部状态；更早记录可能不在已加载范围内。</p>}
        </div>
      </section>
      {selected && fullGroup ? <section className="flex min-h-0 min-w-0 flex-col overflow-hidden rounded-xl border border-slate-800 bg-slate-900/70">
        <header className="border-b border-slate-800 p-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div><h2 className="text-sm font-semibold">{selected.vehicleId} · 车辆告警</h2>
              <p className="mt-1 text-[11px] text-slate-400">{vehicle?.online ? '在线' : '离线 / 状态未知'} · {vehicle?.modeLabel ?? '驾驶模式未知'} · 全车待恢复 {fullGroup.pending} 项</p></div>
            <div className="flex gap-2 text-xs">
              <button type="button" onClick={() => onNavigate(selected.vehicleId)} className="rounded border border-slate-700 px-3 py-1.5 text-sky-200">车辆详情</button>
            </div>
          </div>
          <div className="mt-3 flex flex-wrap gap-x-6 gap-y-2 border-t border-slate-800 pt-3 text-[11px] text-slate-400">
            <span>责任人：暂未接入</span><span>协作人：暂未接入</span><span>处置进度：暂未接入</span>
          </div>
          {vehicle && !vehicle.online && <p className="mt-3 text-xs text-amber-300">车辆已离线，无法确认当前设备状态；未收到恢复的告警仍保留。</p>}
        </header>
        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4">
          <VehicleAlertTimeline key={selected.vehicleId} data={mock.data[selected.vehicleId]} selectedAlert={alert} query={filters.query} />
          <details className="rounded-lg border border-slate-800 p-3">
            <summary className="cursor-pointer text-xs font-medium">告警明细 · {selected.alerts.length} 项匹配</summary>
            <div className="mt-3">
            <div className="mb-2 flex items-center justify-between text-xs"><h3 className="font-medium">告警项 · {selected.alerts.length}</h3>
              <span className="text-slate-500">同车聚合不代表相同根因</span></div>
            {selected.alerts.map((item) => <button type="button" key={item.id} aria-label={`告警 ${item.id}`} aria-pressed={alert?.id === item.id}
              onClick={() => change({ selectedAlert: item.id })}
              className={`mb-2 w-full rounded-lg border p-3 text-left ${alert?.id === item.id ? 'border-sky-700 bg-sky-950/20' : 'border-slate-800 bg-slate-950/40'}`}>
              <div className="flex flex-wrap items-center gap-2 text-xs">
                <span className={`rounded border px-2 py-0.5 text-[10px] ${severityClass(item.severity)}`}>{severityLabel(item.severity)}</span>
                <span className={item.state === 'recovered' ? 'text-emerald-300' : 'text-amber-200'}>{alertStateLabel(item.state)}</span>
                <span className="ml-auto text-[10px] text-slate-500">{item.historyIncomplete ? '记录跨度' : item.state === 'recovered' ? '恢复前持续' : '已持续'} {age(Math.max(0, (item.recoveredAt ?? now) - item.startedAt))}{item.historyIncomplete ? '（起点不完整）' : ''}</span>
              </div>
              <p className="mt-2 break-words text-xs text-slate-200">{item.events.at(-1)?.message}</p>
              <p className="mt-2 break-all text-[10px] text-slate-500">来源 {item.faultKey} · 最近变化 {time(item.updatedAt)}</p>
            </button>)}
            </div>
          </details>
          <div className="text-[11px] text-slate-500">
            {alert?.historyIncomplete && <p className="mt-2 text-[11px] text-amber-300">当前记录不含明确触发起点，不能据此推断完整发生过程。</p>}
            {alert?.state === 'unknown' && <p className="mt-2 text-[11px] text-amber-300">相同时间存在触发与恢复记录且缺少排序依据，恢复状态待确认。</p>}
            分配、协作和验收将在处置流程接入后开放。
          </div>
        </div>
      </section> : <section className="flex flex-col items-center justify-center gap-3 rounded-xl border border-slate-800 bg-slate-900/70 p-8 text-sm text-slate-400">
        <p className="flex items-center"><ArrowLeft className="mr-2 h-4 w-4" />{filters.selectedVehicle ? `${filters.selectedVehicle} 已不符合当前筛选条件` : '选择车辆查看告警与事件记录'}</p>
        {filters.selectedVehicle && <button type="button" onClick={() => change({ state: 'all', vehicle: filters.selectedVehicle, query: '', severity: 'all', period: 'retained' })}
          className="text-xs text-sky-300">查看该车全部状态</button>}
      </section>}
    </div>}
    </>}
  </div>
}
