import React, { useEffect, useRef } from 'react'
import { useMockFleet } from '../app/MockFleetProvider'
import { overviewVehicle } from '../lib/fleet-overview'
import type { MonitorListState } from '../lib/vehicle-monitor'
import TeleopWorkbench from './TeleopWorkbench'

interface Props {
  vehicleId: string | null
  list: MonitorListState
  onListChange: (list: MonitorListState) => void
  onEnter: (id: string) => void
  onBack: () => void
  onMonitor: (id: string) => void
}

export default function RemoteDriving({ vehicleId, list, onListChange, onEnter, onBack, onMonitor }: Props) {
  const mock = useMockFleet()
  const scroll = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (vehicleId === null && scroll.current) scroll.current.scrollTop = list.scrollTop
  }, [vehicleId, list.query, list.filter])
  const map = mock.map
  if (!map) return null
  const rows = mock.vehicles.entries.map((entry) => overviewVehicle(entry, mock.data[entry.vehicle_id], map, performance.now()))
  if (vehicleId !== null) {
    const row = rows.find((value) => value.id === vehicleId)
    if (!row) return <section role="alert" className="space-y-4 p-4">
      <p>车辆 {vehicleId} 已不在当前车辆目录中，工作台不可用。</p>
      <button type="button" onClick={onBack} className="text-sky-300">返回远程驾驶列表</button>
    </section>
    return <TeleopWorkbench key={`${map.id}:${row.id}`} vehicleId={row.id} gear={row.gear === 'P' || row.gear === 'R' || row.gear === 'N' || row.gear === 'D' ? row.gear : '—'}
      networkQuality={null} speedKph={row.speed ?? undefined} batteryPercent={row.battery ?? undefined}
      runModeLabel={row.modeLabel} locationLabel={row.locationReason} row={row} map={map}
      onBack={onBack} onMonitor={() => onMonitor(row.id)} />
  }
  const visible = rows.filter((row) => `${row.id} ${row.name}`.toLowerCase().includes(list.query.trim().toLowerCase()) &&
    (list.filter !== 'offline' || !row.online))
  return <div data-testid="remote-driving-list" className="flex h-full min-h-0 flex-col gap-4">
    <header className="flex flex-wrap items-center justify-between gap-2"><h1 className="text-base font-semibold">远程驾驶</h1>
      <span className="text-xs text-slate-400">选择车辆进入工作台 · 不自动申请控制权</span></header>
    <div className="flex flex-wrap gap-3">
      <input aria-label="搜索远程驾驶车辆" placeholder="搜索车辆编号或名称" value={list.query}
        onChange={(event) => onListChange({ ...list, query: event.target.value, scrollTop: 0 })}
        className="min-w-[220px] flex-1 rounded-lg border border-slate-700 bg-slate-900 p-2 text-xs" />
      {(['all', 'offline'] as const).map((filter) => <button key={filter} type="button" aria-pressed={list.filter === filter}
        onClick={() => onListChange({ ...list, filter, scrollTop: 0 })}
        className={`rounded px-3 py-2 text-xs ${list.filter === filter ? 'bg-sky-900 text-sky-200' : 'bg-slate-900 text-slate-400'}`}>{filter === 'all' ? '全部' : '离线'}</button>)}
    </div>
    <section ref={scroll} onScroll={(event) => {
      if (event.currentTarget.scrollTop !== list.scrollTop) onListChange({ ...list, scrollTop: event.currentTarget.scrollTop })
    }} className="max-h-[calc(100vh-230px)] min-h-0 overflow-auto rounded-xl border border-slate-800 bg-slate-900/70">
      <table className="w-full min-w-[760px] text-left text-xs">
        <thead className="border-b border-slate-800 text-slate-500"><tr>
          {['车辆', '连接', '驾驶模式', '远程会话', '视频状态'].map((label) => <th key={label} className="px-4 py-3 font-normal">{label}</th>)}
        </tr></thead>
        <tbody>{visible.map((row) => <tr key={row.id} onClick={() => onEnter(row.id)}
          className="cursor-pointer border-b border-slate-800 hover:bg-slate-800/50 focus-within:bg-slate-800/50">
          <td className="px-4 py-4"><button type="button" aria-label={`进入 ${row.id} 工作台`} className="w-full text-left">
            <strong>{row.id}</strong><span className="mt-1 block text-[10px] text-slate-500">{row.name.replace(`${row.id} · `, '')}</span>
          </button></td>
          <td className={`px-4 py-4 ${row.online ? 'text-emerald-300' : 'text-slate-400'}`}>{row.online ? '在线' : '离线'}</td>
          <td className="px-4 py-4">{row.modeLabel}</td><td className="px-4 py-4">{row.control}</td>
          <td className="px-4 py-4 text-slate-400">未接入</td>
        </tr>)}</tbody>
      </table>
      {!visible.length && <p className="p-8 text-center text-xs text-slate-400">没有匹配车辆</p>}
    </section>
    <p className="text-[11px] text-slate-500">Mock 演示 · 视频与控制未接入，工作台仅供监看布局预览。远程会话状态不代表车辆可控制。</p>
  </div>
}
