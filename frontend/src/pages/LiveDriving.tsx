import React, { useCallback, useEffect, useRef, useState } from 'react'
import { useAuth } from '../app/AuthProvider'
import { useVehicles } from '../hooks/use-vehicles'
import { useDrivingCameras } from '../hooks/use-driving-cameras'
import { type CameraFeedTrack, type CameraFrameStats } from '../lib/camera-feed'
import { isSingleFront, type FrontCamera } from '../lib/camera-view'
import { TeleopDiagnosticsBuffer } from '../lib/teleop-diagnostics'
import ThreeCameraView from './ThreeCameraView'
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

import { useBenchCameras } from '../hooks/use-bench-cameras'

function viewingStatus(cameras: ReturnType<typeof useDrivingCameras>) {
  const single = isSingleFront(cameras.tracks)
  const names = single ? ['front'] as const : ['left', 'center', 'right'] as const
  const count = names.filter(name => Boolean(cameras.tracks[name]) && cameras.frames[name] === cameras.tracks[name]).length
  const transport = cameras.error ? '监看已结束' : cameras.recovering ? '正在恢复连接'
    : cameras.signalRecovering ? '信令正在恢复' : cameras.connected ? '已连接' : '正在连接'
  return `${transport} · ${count}/${names.length} 路出帧${cameras.connected && count === 0 ? '（等待视频）' : ''}`
}

function LiveWorkbench({ vehicleId, bearer, onBusyChange, onClose, observeOnly, row, onMonitor, controlDenied }: {
  vehicleId: string; bearer: string; onBusyChange: (busy: boolean) => void; onClose: () => void; observeOnly: boolean
  row: OverviewVehicle; onMonitor: () => void; controlDenied: boolean
}) {
  const diagnostics = useRef(new TeleopDiagnosticsBuffer())
  const cameras = useDrivingCameras(vehicleId, bearer, true, diagnostics.current)
  const bench = useBenchCameras(vehicleId, bearer, !observeOnly, cameras.connected, cameras.tracks, cameras.frames, diagnostics.current)
  const drivingEnabled = !observeOnly && bench.eligible
  const [busy, setBusy] = useState(false)
  const { reportFrame, reportProgress } = cameras
  const onStats = useCallback((name: FrontCamera, stats: CameraFrameStats) => {
    const extra = stats.lastResidenceMs !== undefined ? `res=${stats.lastResidenceMs}ms` : ''
    diagnostics.current.record('video', 'camera_stats',
      `${name}:ema=${stats.emaIntervalMs}ms,budget=${stats.stallBudgetMs}ms,max=${stats.maxIntervalMs}ms${extra ? `,${extra}` : ''}`)
  }, [])
  const onBusy = useCallback((value: boolean) => { setBusy(value); onBusyChange(value) }, [onBusyChange])
  const onIntent = useCallback(() => {}, [])
  const trackChanged = useCallback((camera: FrontCamera, live: boolean, track?: CameraFeedTrack) => {
    if (!live) bench.invalidate(track)
    reportFrame(camera, live, track)
  }, [bench.invalidate, reportFrame])
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
      runModeLabel={row.modeLabel} locationLabel={row.locationReason} authenticated busy={busy} observeOnly={!drivingEnabled}
      onBack={onClose} onMonitor={onMonitor} videoStatus={viewingStatus(cameras)}
      cameraView={<ThreeCameraView key={cameras.playbackEpoch} vehicleId={vehicleId} tracks={cameras.tracks} frames={cameras.frames} failedCameras={cameras.failedCameras} requireFrameCallback={drivingEnabled} onFrame={trackChanged} onProgress={reportProgress} onStats={onStats} onPresented={bench.present} onSample={drivingEnabled ? bench.sample : undefined} />}
      controlPanel={drivingEnabled
      ? <DrivingControlPanel vehicleId={vehicleId} bearer={bearer} videoReady={bench.ready} verifyVideo={bench.check} receiverReady={bench.receiverReady} onBusyChange={onBusy} onIntent={onIntent} diagnostics={diagnostics.current} />
      : <div className="space-y-2 text-xs text-amber-200">
          <button type="button" disabled aria-describedby="control-denied-reason"
            className="rounded border border-slate-700 px-3 py-2 opacity-40">申请控制权</button>
          <p id="control-denied-reason">{controlDenied ? '无此车辆的驾驶权限'
            : observeOnly ? '当前角色无驾驶权限' : '源视频新鲜度尚未验证，仅可监看'}</p>
        </div>} />
    {busy && <p className="text-xs text-amber-200">释放并确认车辆交接前，禁止切换车辆或退出工作台。</p>}
  </div>
}

function MonitorCameraFeed({ vehicleId, bearer, onStop }: { vehicleId: string; bearer: string; onStop: () => void }) {
  const cameras = useDrivingCameras(vehicleId, bearer, true)
  const { reportFrame, reportProgress } = cameras
  return <div className="space-y-2 p-3">
    <div className="flex items-center justify-between text-xs">
      <span role="status">{viewingStatus(cameras)}</span>
      <button type="button" onClick={onStop} className="text-sky-200">{cameras.error ? '返回并重新申请' : '停止监看'}</button>
    </div>
    {cameras.error && <p role="alert" className="text-xs text-red-300">{cameras.error}</p>}
    <ThreeCameraView key={cameras.playbackEpoch} vehicleId={vehicleId} tracks={cameras.tracks} frames={cameras.frames} failedCameras={cameras.failedCameras} onFrame={reportFrame} onProgress={reportProgress} />
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
