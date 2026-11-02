import React, { useEffect, useRef, useState } from 'react'
import type { FleetMap } from '../lib/fleet-map'
import type { OverviewVehicle } from '../lib/fleet-overview'
import { bevPoint, bevPose, type BevPose } from '../lib/vehicle-monitor'

export default function VehicleBev({ map, row, compact = false }: { map: FleetMap; row: OverviewVehicle; compact?: boolean }) {
  const [range, setRange] = useState(60)
  const [size, setSize] = useState({ width: 500, height: 400 })
  const container = useRef<HTMLDivElement>(null)
  const previous = useRef<BevPose | undefined>(undefined)
  const pose = bevPose(row, previous.current)
  useEffect(() => {
    if (row.online && row.localizationFresh) previous.current = bevPose(row)
  }, [row])
  useEffect(() => {
    const node = container.current
    if (!node) return
    const observer = new ResizeObserver(([entry]) => {
      if (entry.contentRect.width > 0 && entry.contentRect.height > 0) {
        setSize({ width: entry.contentRect.width, height: entry.contentRect.height })
      }
    })
    observer.observe(node)
    return () => observer.disconnect()
  }, [])
  const points = (line: [number, number][]) => pose ? line.map(([x, y]) => {
    const value = bevPoint({ x, y }, pose, size.width, size.height, range)
    return `${value.x},${value.y}`
  }).join(' ') : ''
  const stale = !row.online || !row.localizationFresh
  const scale = Math.min(size.width, size.height) / range
  return <section className="flex min-w-0 flex-col overflow-hidden rounded-xl border border-slate-800 bg-slate-900/70">
    <header className={`flex flex-wrap items-center justify-between gap-2 border-b border-slate-800 ${compact ? 'p-2' : 'p-3'}`}>
      <div><h2 className="text-sm font-medium">车道级位置</h2><p className="mt-1 text-[11px] text-slate-500">局部 BEV · 车头向上</p></div>
      <select aria-label="局部地图范围" value={range} onChange={(event) => setRange(Number(event.target.value))}
        className="rounded border border-slate-700 bg-slate-950 p-1.5 text-xs text-slate-300">
        <option value={30}>近 · 30 m</option><option value={60}>中 · 60 m</option><option value={120}>远 · 120 m</option>
      </select>
    </header>
    <div ref={container} className={`relative ${compact ? 'h-[160px]' : 'min-h-[300px] flex-1'} overflow-hidden bg-[#080f1c]`}>
      {pose ? <svg aria-label="跟车局部 BEV" data-range={range} data-stale={stale} viewBox={`0 0 ${size.width} ${size.height}`} className="absolute inset-0 h-full w-full">
        <g fill="none" opacity={stale ? 0.45 : 1}>
          {map.lanes.map((lane) => <g key={lane.id}>
            {lane.left.length > 1 && lane.right.length > 1 && <polygon points={points([...lane.left, ...[...lane.right].reverse()])} fill="#172337" fillOpacity="0.7" />}
            {[lane.left, lane.right].map((line, index) => <polyline key={index} points={points(line)} stroke="#71839a" strokeWidth="1.5" />)}
            <polyline points={points(lane.center)} stroke="#2a7893" strokeWidth="1" strokeDasharray="5 6" />
          </g>)}
        </g>
        <g data-testid="bev-vehicle" transform={`translate(${size.width / 2} ${size.height / 2})`}>
          <circle r="23" fill="#0c4a6e" fillOpacity="0.65" stroke={stale ? '#fbbf24' : '#38bdf8'} strokeDasharray={stale ? '4 3' : undefined} />
          <rect x="-7" y="-10" width="14" height="23" rx="3" fill={stale ? '#fbbf24' : '#38bdf8'} />
          <path d="M 0 -21 L -6 -11 L 6 -11 Z" fill={stale ? '#fbbf24' : '#38bdf8'} />
        </g>
      </svg> : <div className="absolute inset-0 flex items-center justify-center p-8 text-center text-xs text-slate-400" role="status">
        {row.position ? '车身朝向未知，无法展示车头向上的局部地图' : row.locationReason}
      </div>}
      {pose && <div className={`absolute left-3 top-3 rounded bg-slate-950/90 px-2 py-1 text-[11px] ${stale ? 'text-amber-300' : 'text-slate-400'}`}>
        {stale ? '最后已知位置 · 已停止跟随' : '随车辆位置与航向更新'}
      </div>}
      {pose && <div className="absolute bottom-3 left-3 text-[10px] text-slate-400">
        <div className="mb-1 border-x border-b border-slate-300" style={{ width: 5 * scale }} />5 m
      </div>}
    </div>
    {!compact && <footer className="border-t border-slate-800 px-3 py-2 text-[10px] text-slate-500">地图车道参考 · 未接入车道匹配、规划和周边目标</footer>}
  </section>
}
