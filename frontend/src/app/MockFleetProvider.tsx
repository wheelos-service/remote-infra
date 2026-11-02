import React, { createContext, useContext, useEffect, useMemo, useState } from 'react'
import { fleetMapSchema, mapCatalogSchema, type FleetMap, type MapCatalog } from '../lib/fleet-map'
import { createMockFleet, createMockVehicleData } from '../lib/mock-fleet'
import type { VehiclesState } from '../hooks/use-vehicles'
import type { VehicleData } from '../lib/vehicle-data-api'

interface MockFleetState {
  enabled: boolean
  map?: FleetMap
  catalog?: MapCatalog
  selectedMap: string
  error?: string
  paused: boolean
  vehicles: VehiclesState
  data: Record<string, VehicleData>
  selectMap: (id: string) => void
  setPaused: (paused: boolean) => void
  reset: () => void
}
const Context = createContext<MockFleetState | undefined>(undefined)
const empty: VehiclesState = { entries: [], status: 'loading', requestFailed: false }

async function loadAsset(url: string, signal: AbortSignal): Promise<unknown> {
  const response = await fetch(url, { signal, cache: 'no-store' })
  if (!response.ok) throw new Error(`地图资源不可用 (${response.status})；请先运行 npm run prepare:maps`)
  const text = await response.text()
  if (text.length > 8 * 1024 * 1024) throw new Error('地图资源超过 8 MiB')
  return JSON.parse(text)
}

export function MockFleetProvider({ children, defaultEnabled = false }: React.PropsWithChildren<{ defaultEnabled?: boolean }>) {
  const query = new URLSearchParams(window.location.search)
  const enabled = defaultEnabled || query.get('preview') === '1' && query.get('fleet') === '1'
  const [catalog, setCatalog] = useState<MapCatalog>()
  const [selectedMap, selectMap] = useState('')
  const [map, setMap] = useState<FleetMap>()
  const [error, setError] = useState<string>()
  const [paused, setPaused] = useState(false)
  const [epoch, setEpoch] = useState(() => ({ wall: Date.now(), mono: performance.now() }))
  const [clock, setClock] = useState(() => ({ elapsed: 0, received: performance.now() }))
  const reset = () => {
    const mono = performance.now()
    setEpoch({ wall: Date.now(), mono })
    setClock({ elapsed: 0, received: mono })
  }
  useEffect(() => {
    if (!enabled) return
    let cancelled = false
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 8_000)
    void loadAsset('./maps/index.json', controller.signal).then((raw) => {
      if (cancelled) return
      const value = mapCatalogSchema.parse(raw)
      setCatalog(value)
      const requested = new URLSearchParams(window.location.search).get('map')
      if (requested && !value.maps.some((map) => map.id === requested)) throw new Error('指定地图不在本地目录中')
      selectMap(requested ?? value.maps[0].id)
    }).catch((failure) => {
      if (!cancelled) setError(`地图目录加载失败：${failure instanceof Error ? failure.message : String(failure)}`)
    }).finally(() => clearTimeout(timer))
    return () => { cancelled = true; clearTimeout(timer); controller.abort() }
  }, [enabled])
  useEffect(() => {
    if (!enabled || !selectedMap) return
    let cancelled = false
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 8_000)
    setError(undefined)
    setMap(undefined)
    void loadAsset(`./maps/${encodeURIComponent(selectedMap)}.json`, controller.signal).then((raw) => {
      if (cancelled) return
      const value = fleetMapSchema.parse(raw)
      if (value.id !== selectedMap) throw new Error('地图 ID 与选择不符')
      setMap(value)
      reset()
    }).catch((failure) => {
      if (!cancelled) setError(`地图加载失败：${failure instanceof Error ? failure.message : String(failure)}`)
    }).finally(() => clearTimeout(timer))
    return () => { cancelled = true; clearTimeout(timer); controller.abort() }
  }, [enabled, selectedMap])
  useEffect(() => {
    if (!enabled || !map || paused) return
    const timer = setInterval(() => {
      const now = performance.now()
      setClock({ elapsed: Math.max(0, Math.floor(now - epoch.mono)), received: now })
    }, 500)
    return () => clearInterval(timer)
  }, [enabled, map, paused, epoch])
  const currentMap = map?.id === selectedMap ? map : undefined
  const snapshot = useMemo(() => {
    if (!enabled || !currentMap) return { vehicles: empty, data: {} }
    const vehicles = createMockFleet(currentMap, clock.elapsed, epoch.wall, clock.received)
    const data = Object.fromEntries(vehicles.entries.map((entry) => [
      entry.vehicle_id, createMockVehicleData(entry.vehicle_id, currentMap, clock.elapsed, epoch.wall),
    ]))
    return { vehicles, data }
  }, [enabled, currentMap, clock, epoch])
  return <Context.Provider value={{
    enabled, map: currentMap, catalog, selectedMap, error, paused, ...snapshot, selectMap, setPaused, reset,
  }}>{children}</Context.Provider>
}

export function useMockFleet() {
  const value = useContext(Context)
  if (!value) throw new Error('Missing MockFleetProvider')
  return value
}

export function MockFleetControls() {
  const mock = useMockFleet()
  if (!mock.enabled) return null
  return <section className="mb-4 space-y-2 rounded-lg border border-amber-800 bg-amber-950/20 p-3 text-xs text-amber-100">
    <div className="flex flex-wrap items-center gap-3">
      <strong>动态 Mock · 8 辆模拟车 · 非实时车辆 · 禁止控制</strong>
      <label>地图 <select aria-label="Mock 地图" value={mock.selectedMap} onChange={(event) => mock.selectMap(event.target.value)}
        className="rounded border border-slate-600 bg-slate-950 p-1">
        {!mock.catalog && <option value="">等待地图目录</option>}
        {mock.catalog?.maps.map((map) => <option key={map.id} value={map.id}>{map.version}</option>)}
      </select></label>
      <button type="button" disabled={!mock.map} onClick={() => mock.setPaused(!mock.paused)} className="rounded border border-amber-700 px-2 py-1 disabled:opacity-40">
        {mock.paused ? '恢复 Mock 上报' : '暂停 Mock 上报'}
      </button>
      <button type="button" disabled={!mock.map} onClick={mock.reset} className="rounded border border-amber-700 px-2 py-1 disabled:opacity-40">重置场景</button>
    </div>
    <p>2 Hz 合成上报；sim-005 定位过期，sim-006 在 20 秒恢复，sim-007 离线，sim-008 每 30 秒换流。暂停后读数继续老化。路线末端循环，不模拟物理运动。</p>
    {mock.error && <p role="alert">{mock.error}</p>}
    {!mock.map && !mock.error && <p role="status">正在加载本地只读地图资源…</p>}
  </section>
}
