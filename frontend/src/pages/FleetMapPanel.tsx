import React, { useEffect, useRef, useState } from 'react'
import type { FleetMap } from '../lib/fleet-map'
import { directoryOnline, getSampleFreshness, type ReceivedVehicle } from '../lib/vehicle-telemetry'

interface Props {
  map: FleetMap
  entries: ReceivedVehicle[]
  selectedId: string
  select: (id: string) => void
  nowMs: number
  requestFailed: boolean
}
type Trail = { stream: string; sequence: number; points: [number, number][] }

export default function FleetMapPanel({ map, entries, selectedId, select, nowMs, requestFailed }: Props) {
  const [zoom, setZoom] = useState(1)
  const [pan, setPan] = useState({ x: 0, y: 0 })
  const [trails, setTrails] = useState<Record<string, Trail>>({})
  const drag = useRef<{ x: number; y: number; panX: number; panY: number } | undefined>(undefined)
  const [minX, minY, maxX, maxY] = map.bounds
  const width = maxX - minX, height = maxY - minY
  const padding = Math.max(width, height) * 0.06
  const viewWidth = (width + padding * 2) / zoom, viewHeight = (height + padding * 2) / zoom
  const x = (value: number) => value - minX
  const y = (value: number) => maxY - value
  const radius = Math.max(width, height) / 85
  useEffect(() => {
    setTrails((previous) => {
      const next: Record<string, Trail> = {}
      for (const entry of entries) {
        const state = entry.state, position = state?.localization.message?.position
        if (!state || state.localization.message?.frame_id !== map.frame_id) continue
        const old = previous[entry.vehicle_id]
        if (typeof position?.x !== 'number' || typeof position.y !== 'number' ||
          !directoryOnline(entry, requestFailed, performance.now()) ||
          getSampleFreshness(state.localization, entry, performance.now()).state !== 'fresh') {
          if (old) next[entry.vehicle_id] = old
          continue
        }
        const unchanged = old?.stream === state.stream_id && old.sequence === state.sequence
        next[entry.vehicle_id] = unchanged ? old : {
          stream: state.stream_id, sequence: state.sequence,
          points: [...(old?.stream === state.stream_id ? old.points : []), [position.x, position.y] as [number, number]].slice(-60),
        }
      }
      return next
    })
  }, [entries, map.frame_id, requestFailed])
  const unmatched = entries.filter((entry) => entry.state?.localization.message?.frame_id !== map.frame_id)
  return <section className="rounded-xl border border-slate-800 bg-slate-900/70 p-3">
    <header className="mb-2 flex flex-wrap items-center justify-between gap-2 text-xs">
      <div><strong>多车地图 · {map.version}</strong><p className="mt-1 text-slate-400">原始地图米制坐标 · {map.lanes.length} 条车道 · 最近 60 个新鲜样本轨迹 · 非导航/控制</p></div>
      <div className="flex gap-2">
        <button type="button" aria-label="放大地图" className="rounded border border-slate-600 px-2 py-1" onClick={() => setZoom(Math.min(8, zoom * 1.5))}>+</button>
        <button type="button" aria-label="缩小地图" className="rounded border border-slate-600 px-2 py-1" onClick={() => setZoom(Math.max(1, zoom / 1.5))}>−</button>
        <button type="button" className="rounded border border-slate-600 px-2 py-1" onClick={() => { setZoom(1); setPan({ x: 0, y: 0 }) }}>适配全图</button>
      </div>
    </header>
    <svg role="img" aria-label="模拟车队高精地图" className="h-80 w-full touch-none rounded bg-slate-950"
      viewBox={`${width / 2 - viewWidth / 2 + pan.x} ${height / 2 - viewHeight / 2 + pan.y} ${viewWidth} ${viewHeight}`}
      onPointerDown={(event) => {
        if (event.button !== 0 || event.target !== event.currentTarget) return
        event.currentTarget.setPointerCapture(event.pointerId)
        drag.current = { x: event.clientX, y: event.clientY, panX: pan.x, panY: pan.y }
      }}
      onPointerMove={(event) => {
        const start = drag.current
        if (!start) return
        const rect = event.currentTarget.getBoundingClientRect()
        const scale = Math.max(viewWidth / rect.width, viewHeight / rect.height)
        setPan({ x: start.panX - (event.clientX - start.x) * scale, y: start.panY - (event.clientY - start.y) * scale })
      }}
      onPointerUp={() => { drag.current = undefined }} onPointerCancel={() => { drag.current = undefined }}
      onLostPointerCapture={() => { drag.current = undefined }}>
      <g fill="none" pointerEvents="none">
        {map.lanes.map((lane) => <g key={lane.id}>
          {[lane.left, lane.right].map((points, index) => <polyline key={index}
            points={points.map(([px, py]) => `${x(px)},${y(py)}`).join(' ')}
            stroke="#475569" strokeWidth={radius / 5} />)}
          <polyline points={lane.center.map(([px, py]) => `${x(px)},${y(py)}`).join(' ')}
            stroke="#164e63" strokeWidth={radius / 6} />
        </g>)}
        {Object.entries(trails).map(([id, trail]) => <polyline key={id}
          points={trail.points.map(([px, py]) => `${x(px)},${y(py)}`).join(' ')}
          stroke={id === selectedId ? '#38bdf8' : '#0e7490'} strokeWidth={radius / 3} />)}
      </g>
      {entries.map((entry) => {
        const sample = entry.state?.localization
        const position = sample?.message?.position
        if (sample?.message?.frame_id !== map.frame_id || typeof position?.x !== 'number' || typeof position.y !== 'number') return null
        const online = directoryOnline(entry, requestFailed, nowMs)
        const fresh = getSampleFreshness(sample, entry, nowMs).state === 'fresh'
        const color = !online ? '#94a3b8' : !fresh ? '#fbbf24' : '#34d399'
        return <g key={entry.vehicle_id} role="button" tabIndex={0} aria-label={`选择 ${entry.vehicle_id}`}
          onClick={() => select(entry.vehicle_id)} onKeyDown={(event) => {
            if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); select(entry.vehicle_id) }
          }} style={{ cursor: 'pointer' }}>
          <title>{entry.name} · {!online ? '离线旧位置' : !fresh ? '定位过期 / 未知' : '模拟位置新鲜'}</title>
          <circle cx={x(position.x)} cy={y(position.y)} r={radius} fill={color}
            stroke={entry.vehicle_id === selectedId ? '#ffffff' : '#0f172a'} strokeWidth={radius / 4} />
          {typeof sample.message?.heading_rad === 'number' && <path
            d={`M ${radius * 1.8} 0 L ${radius * 0.5} ${-radius * 0.55} L ${radius * 0.5} ${radius * 0.55} Z`}
            fill={color} transform={`translate(${x(position.x)} ${y(position.y)}) rotate(${-sample.message.heading_rad * 180 / Math.PI})`} />}
          <text x={x(position.x) + radius * 1.5} y={y(position.y) - radius * 1.5}
            fill="#e2e8f0" fontSize={radius * 1.5}>{entry.vehicle_id}</text>
        </g>
      })}
    </svg>
    <p className="mt-2 text-[11px] text-slate-400">绿色：新鲜模拟定位 · 黄色：定位过期/未知 · 灰色：离线旧位置。点击车辆联动详情；拖拽空白平移。坐标未经地理投影。</p>
    {unmatched.length > 0 && <p role="alert" className="mt-1 text-xs text-amber-200">{unmatched.map((entry) => entry.vehicle_id).join('、')} 坐标系不匹配或定位缺失，未叠加。</p>}
  </section>
}
