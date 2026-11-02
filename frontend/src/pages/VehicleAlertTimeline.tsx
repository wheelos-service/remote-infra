import React, { useEffect, useRef, useState } from 'react'
import type { VehicleData } from '../lib/vehicle-data-api'
import { severityLabel, vehicleTimeline, type VehicleAlert } from '../lib/vehicle-alerts'

interface Props {
  data: VehicleData | undefined
  selectedAlert: VehicleAlert | undefined
  query: string
}
const time = (value: number) => new Date(value).toLocaleString('zh-CN', { hour12: false })

export default function VehicleAlertTimeline({ data, selectedAlert, query }: Props) {
  const [kind, setKind] = useState('all')
  const [onlySelected, setOnlySelected] = useState(false)
  const [newest, setNewest] = useState(false)
  const items = vehicleTimeline(data)
  const [seen, setSeen] = useState(() => new Set(items.map((item) => item.id)))
  const list = useRef<HTMLOListElement>(null)
  const selectedIds = new Set(selectedAlert?.events.map((event) => event.event_id))
  const visible = items.filter((item) => (kind === 'all' || item.kind === kind) &&
    (!onlySelected || selectedIds.has(item.event.event_id)))
  if (newest) visible.reverse()
  const added = items.filter((item) => !seen.has(item.id)).length
  const exact = query.trim().toLowerCase()
  useEffect(() => {
    if (!exact) return
    const node = [...(list.current?.querySelectorAll<HTMLElement>('[data-event-id]') ?? [])]
      .find((element) => element.dataset.eventId?.toLowerCase() === exact)
    node?.scrollIntoView({ block: 'nearest' })
  }, [exact])
  return <section className="rounded-lg border border-slate-800 bg-slate-950/40 p-3" data-testid="vehicle-timeline">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <h3 className="text-xs font-medium">{onlySelected ? '单项告警时间线' : '全车时间线'} · {visible.length} 条</h3>
      <div className="flex flex-wrap items-center gap-2 text-[11px] text-slate-400">
        <select aria-label="时间线类型" value={kind} onChange={(event) => setKind(event.target.value)} className="rounded border border-slate-700 bg-slate-950 p-1.5">
          <option value="all">全部记录</option><option value="device">设备事件</option><option value="human">人工记录</option>
        </select>
        <button type="button" onClick={() => setNewest(!newest)} className="rounded border border-slate-700 px-2 py-1.5">{newest ? '最新在前' : '最早在前'}</button>
        {selectedAlert && <button type="button" aria-pressed={onlySelected} onClick={() => setOnlySelected(!onlySelected)}
          className="rounded border border-slate-700 px-2 py-1.5 text-sky-300">{onlySelected ? '恢复全车时间线' : '仅看选中告警'}</button>}
      </div>
    </div>
    <p className="mt-2 text-[10px] text-slate-500">覆盖该车已加载的全部告警与知悉记录，不受左侧队列筛选限制。同一时间不代表因果顺序。</p>
    {added > 0 && <button type="button" onClick={() => {
      setSeen(new Set(items.map((item) => item.id)))
      const nodes = list.current?.querySelectorAll<HTMLElement>('[data-event-id]')
      const node = newest ? nodes?.[0] : nodes?.[nodes.length - 1]
      node?.scrollIntoView({ block: 'nearest' })
    }} className="mt-3 rounded bg-sky-950 px-3 py-1.5 text-xs text-sky-200">新增 {added} 条记录 · 查看</button>}
    <ol ref={list} className="mt-4 space-y-3" style={{ overflowAnchor: 'none' }}>
      {visible.map((item) => <li key={item.id} data-event-id={item.event.event_id} data-kind={item.kind}
        className={`border-l-2 py-1 pl-3 ${exact === item.event.event_id.toLowerCase() ? 'border-sky-400 bg-sky-950/40' :
          selectedIds.has(item.event.event_id) ? 'border-sky-800' : 'border-slate-700'}`}>
        <div className="flex flex-wrap items-center justify-between gap-2 text-[11px]">
          <span className={item.kind === 'human' ? 'text-sky-300' : item.event.transition === 'recovered' ? 'text-emerald-300' : 'text-amber-200'}>
            {item.kind === 'human' ? '人工知悉' : item.event.transition === 'raised' ? '设备触发' : item.event.transition === 'changed' ? '告警变化' : '设备恢复'}
            {item.kind === 'device' && ` · ${severityLabel(item.event.severity)}`}
          </span>
          <time className="text-slate-500">{time(item.at)}</time>
        </div>
        <p className="mt-1 break-words text-xs text-slate-300">{item.kind === 'human' ? `${item.operator} 已知悉；不代表设备恢复或处置完成` : item.event.message}</p>
        <details className="mt-2 text-[10px] text-slate-500">
          <summary className="cursor-pointer">事件 {item.event.event_id}</summary>
          <p className="mt-1 break-all">来源 {item.event.fault_key}</p>
        </details>
      </li>)}
    </ol>
    {!visible.length && <p className="py-5 text-center text-xs text-slate-500">暂无匹配的时间线记录</p>}
  </section>
}
