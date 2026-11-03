import React, { useCallback, useEffect, useState } from 'react'
import { useAuth } from '../app/AuthProvider'
import { useVehicles } from '../hooks/use-vehicles'
import { useDrivingCameras } from '../hooks/use-driving-cameras'
import { threeCamerasReady, type CameraFeedTrack } from '../lib/camera-feed'
import { teleopConfig } from '../lib/teleop-config'
import ThreeCameraView, { type FrontCamera } from './ThreeCameraView'
import { SimulationControlPanel } from './SimulationControlPanel'

function LiveWorkbench({ vehicleId, bearer, onBusyChange, onClose }: {
  vehicleId: string; bearer: string; onBusyChange: (busy: boolean) => void; onClose: () => void
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
    <header className="flex flex-wrap items-center justify-between gap-3 text-sm">
      <h1>{vehicleId} · C++ 远程驾驶工作台</h1>
      <button type="button" disabled={busy} onClick={onClose} className="rounded border border-slate-700 px-3 py-2 disabled:opacity-40">断开监看并返回列表</button>
    </header>
    <p className="text-xs text-amber-200">实时 RTC · 车端合成三相机 · v2 模拟控制 · 不连接实车执行器</p>
    <p className="text-xs text-slate-300">视频连接：{cameras.connected ? '已连接' : '未连接 / 正在连接'} · 三路：{videoReady ? '正在出帧' : '未就绪'} · 网络质量未测量</p>
    {cameras.error && <p role="alert" className="text-xs text-red-300">{cameras.error}</p>}
    <ThreeCameraView vehicleId={vehicleId} tracks={cameras.tracks} onFrame={onFrame} />
    {teleopConfig.simulationControl
      ? <SimulationControlPanel vehicleId={vehicleId} bearer={bearer} videoReady={videoReady} onBusyChange={onBusy} onIntent={onIntent} />
      : <p className="text-xs text-amber-200">仅监看；部署未启用 simulationControl，不开放控制输入。</p>}
    {busy && <p className="text-xs text-amber-200">释放并确认模拟交接前，禁止切换车辆或退出工作台。</p>}
  </div>
}

export default function LiveDriving() {
  const auth = useAuth()
  const vehicles = useVehicles(auth.accessToken)
  const [selected, setSelected] = useState('')
  const [busy, setBusy] = useState(false)
  const close = () => { setSelected(''); setBusy(false) }
  return <main className="min-h-screen space-y-4 bg-slate-950 p-4 pb-24 text-slate-100">
    <header className="flex flex-wrap justify-between gap-3 text-sm">
      <span>C++ v2 · 三相机远程工作台</span>
      <div className="flex flex-wrap gap-3">
        {!selected && <a href="#/" className="text-sky-200">返回 Mock 运维平台</a>}
        {auth.accessToken ? <>
          <span>{auth.operator?.Name}</span>
          <button type="button" disabled={Boolean(selected) || busy} onClick={auth.signOut} className="disabled:opacity-40">退出登录</button>
        </> : <>
          <button type="button" disabled={auth.loading} onClick={() => void auth.signIn()}>登录</button>
          {auth.isDevLoginAvailable && <button type="button" onClick={() => void auth.signInWithDevToken()}>本机开发令牌登录</button>}
        </>}
      </div>
    </header>
    <p className="text-xs text-amber-200">与 Mock 目录隔离。只读取获授权车辆；进入页面不自动建立监看或控制会话。控制仅用于注册的 C++ 模拟车辆。</p>
    {(auth.error || vehicles.error) && <p role="alert" className="text-xs text-red-300">{auth.error || vehicles.error}</p>}
    {selected && auth.accessToken
      ? <LiveWorkbench key={`${auth.accessToken}:${selected}`} vehicleId={selected} bearer={auth.accessToken} onBusyChange={setBusy} onClose={close} />
      : <section className="space-y-3">
        <h1 className="text-base">授权车辆 · 选择后显式开始监看</h1>
        {!auth.accessToken && <p className="text-xs text-slate-400">请先登录。</p>}
        {vehicles.status === 'loading' && <p className="text-xs">正在加载车辆目录…</p>}
        {vehicles.entries.map(vehicle => <div key={vehicle.vehicle_id} className="flex flex-wrap justify-between gap-3 rounded border border-slate-800 p-3 text-xs">
          <span>{vehicle.name || vehicle.vehicle_id} · {vehicle.vehicle_id}</span>
          <button type="button" disabled={vehicles.requestFailed} onClick={() => setSelected(vehicle.vehicle_id)}
            className="text-sky-200 disabled:opacity-40">开始三路监看</button>
        </div>)}
        {vehicles.status === 'ready' && !vehicles.entries.length && <p className="text-xs">当前账号没有授权车辆。</p>}
      </section>}
  </main>
}
