import React, { useCallback, useEffect, useRef, useState } from 'react'
import { useAuth } from '../app/AuthProvider'
import { useVehicles } from '../hooks/use-vehicles'
import { useDrivingCameras } from '../hooks/use-driving-cameras'
import { threeCamerasReady, type CameraFeedTrack } from '../lib/camera-feed'
import ThreeCameraView, { type FrontCamera } from './ThreeCameraView'
import { DrivingControlPanel } from './DrivingControlPanel'
import TeleopWorkbench from './TeleopWorkbench'
import { FleetOverviewContent } from './FleetOverview'
import { VehicleMonitorDetail, VehicleMonitorList } from './VehicleMonitor'
import { useVehicleData } from '../hooks/use-vehicle-data'
import { groupVehicleAlerts } from '../lib/vehicle-alerts'
import type { ReceivedVehicle } from '../lib/vehicle-telemetry'
import { RemoteDrivingList } from './RemoteDriving'
import { overviewVehicle, type OverviewVehicle } from '../lib/fleet-overview'
import type { MonitorListState } from '../lib/vehicle-monitor'
import { canControlVehicle, hasVehicleContext } from '../lib/organization-context'

function LiveWorkbench({ vehicleId, bearer, onBusyChange, onClose, observeOnly, row, onMonitor, controlDenied }: {
  vehicleId: string; bearer: string; onBusyChange: (busy: boolean) => void; onClose: () => void; observeOnly: boolean
  row: OverviewVehicle; onMonitor: () => void; controlDenied: boolean
}) {
  const cameras = useDrivingCameras(vehicleId, bearer)
  const [frames, setFrames] = useState<Partial<Record<FrontCamera, CameraFeedTrack>>>({})
  const [busy, setBusy] = useState(false)
  const onFrame = useCallback((name: FrontCamera, live: boolean, track?: CameraFeedTrack) => {
    setFrames(previous => {
      if (!live && previous[name] !== track) return previous
      const current = live ? track : undefined
      return previous[name] === current ? previous : { ...previous, [name]: current }
    })
  }, [])
  const onBusy = useCallback((value: boolean) => { setBusy(value); onBusyChange(value) }, [onBusyChange])
  const onIntent = useCallback(() => {}, [])
  const videoReady = cameras.connected && threeCamerasReady(Object.fromEntries(
    (['left', 'center', 'right'] as const).map(name => [name, Boolean(cameras.tracks[name]) && frames[name] === cameras.tracks[name]]),
  ))
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => {
      if (busy) { event.preventDefault(); event.returnValue = '' }
    }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [busy])
  return <div className="space-y-4" data-testid="live-driving-workbench">
    {cameras.error && <p role="alert" className="text-xs text-red-300">{cameras.error}</p>}
    <TeleopWorkbench vehicleId={vehicleId} row={row} gear={['P', 'R', 'N', 'D'].includes(row.gear) ? row.gear as 'P' | 'R' | 'N' | 'D' : '—'}
      networkQuality={null} speedKph={row.speed ?? undefined} batteryPercent={row.battery ?? undefined}
      runModeLabel={row.modeLabel} locationLabel={row.locationReason} authenticated busy={busy} observeOnly={observeOnly}
      onBack={onClose} onMonitor={onMonitor} videoStatus={`${cameras.connected ? '已连接' : '未连接 / 正在连接'} · 三路：${videoReady ? '正在出帧' : '未就绪'}`}
      cameraView={<ThreeCameraView vehicleId={vehicleId} tracks={cameras.tracks} onFrame={onFrame} />}
      controlPanel={!observeOnly
      ? <DrivingControlPanel vehicleId={vehicleId} bearer={bearer} videoReady={videoReady} onBusyChange={onBusy} onIntent={onIntent} />
      : <div className="space-y-2 text-xs text-amber-200">
          <button type="button" disabled aria-describedby="control-denied-reason"
            className="rounded border border-slate-700 px-3 py-2 opacity-40">申请控制权</button>
          <p id="control-denied-reason">{controlDenied ? '无此车辆的驾驶权限'
            : observeOnly ? '当前角色无驾驶权限' : '控制暂不可用'}</p>
        </div>} />
    {busy && <p className="text-xs text-amber-200">释放并确认车辆交接前，禁止切换车辆或退出工作台。</p>}
  </div>
}

function MonitorCameraFeed({ vehicleId, bearer, onStop }: { vehicleId: string; bearer: string; onStop: () => void }) {
  const cameras = useDrivingCameras(vehicleId, bearer)
  return <div className="space-y-2 p-3">
    <div className="flex items-center justify-between text-xs">
      <span>{cameras.connected ? '监看已连接' : '正在连接监看…'}</span>
      <button type="button" onClick={onStop} className="text-sky-200">停止监看</button>
    </div>
    {cameras.error && <p role="alert" className="text-xs text-red-300">{cameras.error}</p>}
    <ThreeCameraView vehicleId={vehicleId} tracks={cameras.tracks} />
  </div>
}

function AuthorizedMonitorDetail({ entry, bearer, onBack, onDrive, onAlerts }: {
  entry: ReceivedVehicle; bearer: string; onBack: () => void; onDrive: () => void; onAlerts: () => void
}) {
  const data = useVehicleData(entry.vehicle_id, bearer, true)
  const [watching, setWatching] = useState(false)
  const row = overviewVehicle(entry, data.data, undefined, performance.now())
  return <VehicleMonitorDetail row={row} entry={entry} data={data.data} authenticated dataError={data.error} dataLoading={data.loading}
    group={data.data ? groupVehicleAlerts({ [entry.vehicle_id]: data.data })[0] : undefined}
    onBack={onBack} onDrive={onDrive} onAlerts={onAlerts}
    cameraView={watching ? <MonitorCameraFeed vehicleId={entry.vehicle_id} bearer={bearer} onStop={() => setWatching(false)} />
      : <div className="flex min-h-[300px] items-center justify-center">
        <button type="button" onClick={() => setWatching(true)} className="rounded border border-sky-600 px-4 py-2 text-sm text-sky-200">开始监看</button>
      </div>} />
}

export function AuthorizedVehicleContent({ section, selected = '', onSelect, onMonitor, onDrive, onAlerts, query = '', filter = 'all', onQuery, onFilter }: {
  section: 'drive' | 'monitor' | 'fleet'; selected?: string; onSelect: (id: string) => void
  onMonitor: (id: string) => void; onAlerts: (id?: string) => void; query?: string; filter?: 'all' | 'attention' | 'offline' | 'alerts'
  onDrive?: (id: string) => void
  onQuery: (value: string) => void; onFilter: (value: 'all' | 'attention' | 'offline' | 'alerts') => void
}) {
  const auth = useAuth()
  const vehicles = useVehicles(hasVehicleContext(auth.authorizationContext, auth.organizationId) ? auth.accessToken : undefined, auth.organizationId)
  const close = () => { if (!auth.controlBusy) onSelect('') }
  const organization = auth.organizations.find(org => org.org_id === auth.organizationId)
  const controlGranted = canControlVehicle(auth.authorizationContext, auth.organizationId, selected)
  const observeOnly = section !== 'drive' || !controlGranted
  const selectedAuthorized = selected && (auth.controlBusy || vehicles.entries.some(vehicle => vehicle.vehicle_id === selected))
  const rows = vehicles.entries.map(entry => overviewVehicle(entry, undefined, undefined, performance.now()))
  const retainedRow = useRef<OverviewVehicle | undefined>(undefined)
  const row = rows.find(value => value.id === selected)
  if (row) retainedRow.current = row
  const [scrollTop, setScrollTop] = useState(0)
  const list: MonitorListState = { query, filter: filter === 'attention' ? 'all' : filter, scrollTop }
  const onListChange = (value: MonitorListState) => { onQuery(value.query); onFilter(value.filter); setScrollTop(value.scrollTop) }
  return <section className="space-y-4 pb-24 text-slate-100">
    {(auth.error || vehicles.error) && <p role="alert" className="text-xs text-red-300">{auth.error || vehicles.error}</p>}
    {section === 'monitor' && selectedAuthorized && auth.accessToken && vehicles.entries.find(entry => entry.vehicle_id === selected)
      ? <AuthorizedMonitorDetail key={`${auth.organizationId}:${selected}`} entry={vehicles.entries.find(entry => entry.vehicle_id === selected)!}
        bearer={auth.accessToken} onBack={close} onDrive={() => onDrive?.(selected)} onAlerts={() => onAlerts(selected)} />
      : selectedAuthorized && section === 'drive' && auth.accessToken && (row ?? retainedRow.current)
      ? <LiveWorkbench key={`${auth.organizationId}:${selected}`} vehicleId={selected} bearer={auth.accessToken} onBusyChange={auth.setControlBusy}
        onClose={close} observeOnly={observeOnly} row={(row ?? retainedRow.current)!} onMonitor={() => onMonitor(selected)}
        controlDenied={section === 'drive' && organization?.role === 'remote_operator' && !controlGranted} />
      : <section className="space-y-3">
        {!auth.accessToken && <p className="text-xs text-slate-400">请先登录。</p>}
        {vehicles.status === 'loading' && <p className="text-xs">正在加载车辆目录…</p>}
        {section === 'fleet' ? <FleetOverviewContent entries={vehicles.entries} data={{}} authenticated selected={selected}
          onSelect={(id, detail) => detail ? onMonitor(id) : onSelect(id)} onAlerts={onAlerts} query={query}
          filter={filter === 'alerts' ? 'all' : filter} onQuery={onQuery} onFilter={onFilter} />
          : section === 'monitor' ? <VehicleMonitorList rows={rows} list={list} onListChange={onListChange}
            onSelect={onSelect} onAlerts={onAlerts} authenticated canObserve={!vehicles.requestFailed} />
          : <RemoteDrivingList rows={rows} list={list} onListChange={onListChange} onEnter={onSelect} authenticated
            canObserve={!vehicles.requestFailed} />}
        {vehicles.status === 'ready' && !vehicles.entries.length && <p className="text-xs">当前账号没有授权车辆。</p>}
      </section>}
  </section>
}
