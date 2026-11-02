import React, { useEffect, useMemo, useRef, useState } from 'react'
import { Maximize, Minus, Plus, Settings2 } from 'lucide-react'
import type { FleetMap } from '../lib/fleet-map'
import { fitMap, markerColor, markerLabels, screenPoint, type MapViewport, type OverviewVehicle } from '../lib/fleet-overview'

interface Props {
  map: FleetMap
  rows: OverviewVehicle[]
  selected: string
  focusPosition?: { x: number; y: number }
  onSelect: (id: string) => void
}

export default function DevFleetMap({ map, rows, selected, focusPosition, onSelect }: Props) {
  const container = useRef<HTMLDivElement>(null)
  const drag = useRef<{ x: number; y: number; view: MapViewport } | undefined>(undefined)
  const [size, setSize] = useState({ width: 900, height: 600 })
  const [camera, setCamera] = useState<MapViewport>()
  const lastFocus = useRef<Props['focusPosition']>(undefined)
  const [centers, setCenters] = useState(true)
  const [labels, setLabels] = useState(true)
  const [grid, setGrid] = useState(true)
  const [trail, setTrail] = useState<{ id: string; stream: string | null; sequence: number | null; points: { x: number; y: number }[] }>()
  const fitted = useMemo(() => fitMap(map.bounds, size.width, size.height), [map, size])
  const view = camera ? { ...camera, height: camera.width * size.height / size.width } : fitted
  useEffect(() => {
    if (!focusPosition || lastFocus.current === focusPosition) return
    lastFocus.current = focusPosition
    setCamera((previous) => {
      const width = Math.min(previous?.width ?? fitted.width, fitted.width / 3)
      return { ...focusPosition, width, height: width * fitted.height / fitted.width }
    })
  }, [focusPosition, fitted])
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
  useEffect(() => {
    const row = rows.find((value) => value.id === selected)
    setTrail((previous) => {
      const old = previous?.id === selected && previous.stream === row?.stream ? previous : undefined
      if (!row?.position || !row.online || !row.localizationFresh) return old
      if (old?.sequence === row.sequence) return old
      const point = { x: row.position.x, y: row.position.y }
      const last = old?.points.at(-1)
      const continuous = last && Math.hypot(last.x - point.x, last.y - point.y) < 30
      return { id: selected, stream: row.stream, sequence: row.sequence, points: [...(continuous ? old?.points ?? [] : []), point].slice(-60) }
    })
  }, [rows, selected])
  const projection = (position: { x: number; y: number }) => screenPoint(position, view, size.width, size.height)
  const curve = (points: [number, number][]) => points.map(([x, y]) => {
    const point = projection({ x, y })
    return `${point.x},${point.y}`
  }).join(' ')
  const projected = markerLabels(rows, view, size.width, size.height, selected)
    .filter(({ position }) => position.x >= -20 && position.x <= size.width + 20 && position.y >= -20 && position.y <= size.height + 20)
  const scaleMeters = 10 ** Math.floor(Math.log10(view.width / 6))
  const scalePixels = scaleMeters * size.width / view.width
  const zoom = (factor: number) => {
    const width = Math.min(fitted.width * 2, Math.max(fitted.width / 25, view.width * factor))
    setCamera({ ...view, width, height: width * size.height / size.width })
  }
  return <section className="flex min-h-[440px] min-w-0 flex-col overflow-hidden rounded-xl border border-slate-800 bg-slate-900/70">
    <header className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-800 px-4 py-3">
      <div>
        <h2 className="text-sm font-semibold text-slate-100">位置展示</h2>
        <p className="mt-1 text-[11px] text-slate-400">地图：{map.version}</p>
      </div>
    </header>
    <div ref={container} className="relative min-h-[360px] flex-1 touch-none overflow-hidden bg-[#080f1c]"
      onPointerDown={(event) => {
        if (event.button !== 0 || (event.target instanceof Element && event.target.closest('[data-vehicle],button,details'))) return
        event.currentTarget.setPointerCapture(event.pointerId)
        drag.current = { x: event.clientX, y: event.clientY, view }
      }}
      onPointerMove={(event) => {
        const start = drag.current
        if (!start) return
        setCamera({ ...start.view, x: start.view.x - (event.clientX - start.x) * start.view.width / size.width,
          y: start.view.y + (event.clientY - start.y) * start.view.height / size.height })
      }}
      onPointerUp={() => { drag.current = undefined }} onPointerCancel={() => { drag.current = undefined }}
      onLostPointerCapture={() => { drag.current = undefined }}>
      <svg aria-label="车辆位置地图" role="img" viewBox={`0 0 ${size.width} ${size.height}`} className="absolute inset-0 h-full w-full">
        <defs>
          <pattern id="fleet-grid" width={scalePixels} height={scalePixels} patternUnits="userSpaceOnUse"
            x={projection({ x: 0, y: 0 }).x % scalePixels} y={projection({ x: 0, y: 0 }).y % scalePixels}>
            <path d={`M ${scalePixels} 0 L 0 0 0 ${scalePixels}`} fill="none" stroke="#1b293c" strokeWidth="0.7" />
          </pattern>
        </defs>
        {grid && <rect data-testid="map-grid" width="100%" height="100%" fill="url(#fleet-grid)" />}
        <g fill="none" pointerEvents="none">
          {map.lanes.map((lane) => <g key={lane.id}>
            {lane.left.length > 1 && lane.right.length > 1 && <polygon
              points={curve([...lane.left, ...[...lane.right].reverse()])} fill="#172337" fillOpacity="0.6" />}
            {[lane.left, lane.right].map((points, index) => <polyline key={index} points={curve(points)} stroke="#71839a" strokeOpacity="0.7" strokeWidth="1.2" />)}
            {centers && <polyline points={curve(lane.center)} stroke="#2a7893" strokeWidth="1" strokeDasharray="5 6" />}
          </g>)}
          {trail?.id === selected && trail.points.length > 1 && <polyline data-testid="selected-trail"
            points={trail.points.map((point) => { const p = projection(point); return `${p.x},${p.y}` }).join(' ')}
            stroke="#38bdf8" strokeWidth="2" strokeOpacity="0.75" />}
        </g>
        {projected.filter(({ row }) => row.id !== selected).concat(projected.filter(({ row }) => row.id === selected)).map(({ row, position, label }) => {
          const color = markerColor(row)
          const old = !row.online || !row.localizationFresh
          const chosen = row.id === selected
          return <g key={row.id} data-vehicle={row.id} role="button" tabIndex={0} aria-label={`选择 ${row.id}`} aria-pressed={chosen}
            className="cursor-pointer outline-none focus:opacity-70"
            onClick={() => onSelect(row.id)} onKeyDown={(event) => {
              if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onSelect(row.id) }
            }}>
            <title>{row.id} · {row.modeLabel} · {row.healthLabel} · {row.locationReason}</title>
            <circle cx={position.x} cy={position.y} r="18" fill="transparent" />
            <circle cx={position.x} cy={position.y} r={chosen ? 17 : 12} fill={chosen ? '#0c4a6e' : '#0f172a'}
              stroke={chosen ? '#e0f2fe' : color} strokeWidth={chosen ? 2 : 1} strokeDasharray={old ? '3 3' : undefined} opacity={old ? 0.7 : 1} />
            {row.position?.heading === undefined
              ? <circle cx={position.x} cy={position.y} r="4" fill={color} />
              : <g transform={`translate(${position.x} ${position.y}) rotate(${-row.position.heading * 180 / Math.PI})`} opacity={old ? 0.65 : 1}>
                <rect x="-7" y="-4" width="13" height="8" rx="2" fill={color} />
                <path d="M 12 0 L 5 -4 L 5 4 Z" fill={color} />
              </g>}
            {labels && label && <>
              <line x1={position.x} y1={position.y} x2={label.x + 52} y2={label.y + 12} stroke={color} strokeOpacity="0.5" />
              <rect x={label.x} y={label.y} width="106" height="23" rx="5" fill="#0b1626" stroke={chosen ? '#7dd3fc' : '#334155'} />
              <text x={label.x + 7} y={label.y + 15} fill="#e2e8f0" fontSize="11">{row.id} · {old ? '旧位置' : row.gear}</text>
            </>}
          </g>
        })}
      </svg>
      <details className="absolute left-3 top-3 rounded-lg border border-slate-700 bg-slate-950/95 text-xs text-slate-300">
        <summary aria-label="地图设置" title="地图设置" className="flex cursor-pointer list-none items-center gap-2 p-2.5 [&::-webkit-details-marker]:hidden">
          <Settings2 className="h-4 w-4" aria-hidden="true" /><span>图层</span>
        </summary>
        <div className="flex min-w-[140px] flex-col gap-3 border-t border-slate-800 p-3">
          <label className="flex items-center gap-2"><input type="checkbox" checked={centers} onChange={(event) => setCenters(event.target.checked)} />中心线</label>
          <label className="flex items-center gap-2"><input type="checkbox" checked={labels} onChange={(event) => setLabels(event.target.checked)} />车辆标签</label>
          <label className="flex items-center gap-2"><input type="checkbox" checked={grid} onChange={(event) => setGrid(event.target.checked)} />网格</label>
        </div>
      </details>
      <div className="pointer-events-none absolute bottom-3 left-3 text-[10px] text-slate-400">
        <div style={{ width: scalePixels }} className="mb-1 border-x border-b border-slate-300" />{scaleMeters} m
      </div>
      <div role="group" aria-label="地图操作" className="absolute bottom-3 right-3 flex flex-col overflow-hidden rounded-lg border border-slate-700 bg-slate-950/95 text-slate-200 shadow-lg">
        <button type="button" aria-label="放大地图" title="放大地图" onClick={() => zoom(1 / 1.5)} className="p-2.5 hover:bg-slate-800"><Plus className="h-4 w-4" aria-hidden="true" /></button>
        <button type="button" aria-label="缩小地图" title="缩小地图" onClick={() => zoom(1.5)} className="border-t border-slate-700 p-2.5 hover:bg-slate-800"><Minus className="h-4 w-4" aria-hidden="true" /></button>
        <button type="button" aria-label="适配全图" title="适配全图" onClick={() => setCamera(undefined)} className="border-t border-slate-700 p-2.5 hover:bg-slate-800"><Maximize className="h-4 w-4" aria-hidden="true" /></button>
      </div>
    </div>
    <footer className="flex flex-wrap items-center gap-4 border-t border-slate-800 px-4 py-2 text-[11px] text-slate-400">
      <span className="text-sky-300">● 已采集项正常</span><span className="text-rose-300">● 故障</span>
      <span className="text-amber-300">● 质量异常 / 未知</span><span>◌ 离线旧位置</span>
      <span className="ml-auto">有定位 {rows.filter((row) => row.position).length} / {rows.length} 辆</span>
    </footer>
  </section>
}
