import React, { useState } from 'react'
import { alertPeriodSummary, initialAlertFilters, type AlertFilters, type VehicleAlertGroup } from '../lib/vehicle-alerts'

interface Props {
  groups: VehicleAlertGroup[]
  now: number
  onOpen: (filters: AlertFilters) => void
}
const time = (value: number) => new Date(value).toLocaleString('zh-CN', { hour12: false })

export default function AlertDashboard({ groups, now, onOpen }: Props) {
  const [period, setPeriod] = useState('today')
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const today = new Date(now)
  today.setHours(0, 0, 0, 0)
  const start = period === 'custom' ? new Date(from).getTime() : period === '7d' ? now - 7 * 86_400_000 : today.getTime()
  const end = period === 'custom' ? new Date(to).getTime() : now
  const valid = Number.isFinite(start) && Number.isFinite(end) && start <= end && end <= now
  const summary = valid ? alertPeriodSummary(groups, start, end) : null
  const pending = groups.reduce((count, group) => count + group.pending, 0)
  const affected = groups.filter((group) => group.pending > 0).length
  const critical = groups.filter((group) => group.alerts.some((alert) => alert.state !== 'recovered' &&
    (alert.severity === 'ERROR' || alert.severity === 'FATAL'))).length
  return <div className="space-y-5" data-testid="alert-dashboard">
    <section>
      <h2 className="mb-3 text-sm font-medium">当前状态<span className="ml-3 text-[11px] font-normal text-slate-500">不随统计时段变化</span></h2>
      <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
        {[
          { label: '告警车辆', value: affected, unit: '辆', severity: 'all' as const, color: 'text-amber-200' },
          { label: '待恢复告警', value: pending, unit: '项', severity: 'all' as const, color: 'text-amber-200' },
          { label: '严重告警车辆', value: critical, unit: '辆', severity: 'critical' as const, color: 'text-rose-300' },
        ].map((item) => <button key={item.label} type="button" data-testid={`metric-${item.label}`}
          onClick={() => onOpen({ ...initialAlertFilters, severity: item.severity })}
          className="rounded-xl border border-slate-800 bg-slate-900/70 p-4 text-left hover:border-sky-700">
          <p className="text-xs text-slate-400">{item.label}</p>
          <p className={`mt-3 text-2xl font-semibold ${item.value ? item.color : 'text-slate-400'}`}>{item.value}<span className="ml-2 text-xs font-normal text-slate-500">{item.unit}</span></p>
          <p className="mt-3 text-[11px] text-sky-300">查看车辆 →</p>
        </button>)}
        <div className="rounded-xl border border-slate-800 bg-slate-900/70 p-4">
          <p className="text-xs text-slate-400">待验证处置</p><p className="mt-3 text-sm text-slate-500">暂未接入</p>
          <p className="mt-3 text-[11px] text-slate-500">需人工验收流程</p>
        </div>
      </div>
    </section>
    <section className="rounded-xl border border-slate-800 bg-slate-900/70 p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-sm font-medium">时段统计</h2>
        <label className="text-xs text-slate-400">统计时段
          <select aria-label="看板统计时段" value={period} onChange={(event) => setPeriod(event.target.value)} className="ml-2 rounded border border-slate-700 bg-slate-950 p-2 text-slate-200">
            <option value="today">今日</option><option value="7d">近7天</option><option value="custom">自定义</option>
          </select>
        </label>
      </div>
      {period === 'custom' && <div className="mt-3 flex flex-wrap gap-3 text-xs text-slate-400">
        <label>开始 <input aria-label="统计开始时间" type="datetime-local" value={from} onChange={(event) => setFrom(event.target.value)} className="rounded border border-slate-700 bg-slate-950 p-2" /></label>
        <label>结束 <input aria-label="统计结束时间" type="datetime-local" value={to} onChange={(event) => setTo(event.target.value)} className="rounded border border-slate-700 bg-slate-950 p-2" /></label>
      </div>}
      <p className={`mt-3 text-[11px] ${valid ? 'text-slate-500' : 'text-amber-300'}`} role={valid ? undefined : 'alert'}>
        {valid ? `${time(start)} — ${time(end)} · ${Intl.DateTimeFormat().resolvedOptions().timeZone}` : '请选择有效的起止时间，结束时间不能晚于当前时间。'}
      </p>
      <div className="mt-4 grid grid-cols-2 gap-3 xl:grid-cols-4">
        {[
          { label: '新增告警车辆', value: summary?.vehicles, unit: '辆' },
          { label: '新增告警', value: summary?.added, unit: '次' },
          { label: '设备恢复告警', value: summary?.recovered, unit: '次' },
        ].map((item) => <div key={item.label} data-testid={`period-${item.label}`} className="rounded-lg bg-slate-950/60 p-4">
          <p className="text-xs text-slate-400">{item.label}</p><p className="mt-3 text-xl font-semibold">{item.value ?? '—'}<span className="ml-2 text-xs font-normal text-slate-500">{item.unit}</span></p>
        </div>)}
        <div className="rounded-lg bg-slate-950/60 p-4">
          <p className="text-xs text-slate-400">完成处置车次</p><p className="mt-3 text-sm text-slate-500">暂未接入</p>
          <p className="mt-2 text-[11px] text-slate-500">设备恢复不等于人工完成</p>
        </div>
      </div>
    </section>
    <p className="text-[11px] leading-5 text-slate-500">仅统计已加载记录，非完整日报。人工处置统计及正式报表将在接入处置流程和完整历史后提供。</p>
  </div>
}
