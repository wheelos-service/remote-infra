import React, { useEffect, useRef, useState } from 'react'
import { bindCameraFeed, type CameraFeedTrack } from '../lib/camera-feed'

export type FrontCamera = 'left' | 'center' | 'right'
export const frontCameras: { name: FrontCamera; label: string }[] = [
  { name: 'left', label: '前左' }, { name: 'center', label: '前中' }, { name: 'right', label: '前右' },
]

function CameraSlot({ name, label, track, onFrame }: {
  name: FrontCamera; label: string; track?: CameraFeedTrack
  onFrame?: (name: FrontCamera, live: boolean, track?: CameraFeedTrack) => void
}) {
  const video = useRef<HTMLVideoElement>(null)
  const boundTrack = useRef<CameraFeedTrack | undefined>(undefined)
  const [live, setLive] = useState(false)
  const [latency, setLatency] = useState<number>()
  useEffect(() => {
    boundTrack.current = track
    setLive(false)
    setLatency(undefined)
    onFrame?.(name, false, track)
    if (!track || !video.current) return
    return bindCameraFeed(track, video.current, (value) => {
      setLive(value)
      onFrame?.(name, value, track)
    }, setLatency)
  }, [name, track, onFrame])
  const currentLive = live && boundTrack.current === track
  return <section data-camera={name} className="relative flex min-h-0 min-w-0 flex-col overflow-hidden rounded-lg border border-slate-700 bg-black">
    <header className="flex flex-wrap justify-between gap-x-2 gap-y-1 bg-slate-900 px-3 py-2 text-xs">
      <span>{label}</span><span className={currentLive ? 'text-emerald-300' : 'text-amber-300'}>{currentLive ? '正在出帧' : track ? '停更 / 等待出帧' : '等待视频'}</span>
      <span className="text-slate-300">读取至预计显示（估计）：{currentLive && latency !== undefined ? `${Math.round(latency)} ms` : '未知'}</span>
    </header>
    <div className="relative min-h-0 flex-1">
      <video ref={video} className={`h-full w-full object-contain ${currentLive ? '' : 'invisible'}`} />
      {!currentLive && <p className="absolute inset-0 flex items-center justify-center p-3 text-center text-xs text-amber-200">{track ? '画面未更新 · 不可驾驶' : '未接入该相机'}</p>}
    </div>
  </section>
}

export default function ThreeCameraView({ vehicleId, tracks = {}, onFrame }: {
  vehicleId: string; tracks?: Partial<Record<FrontCamera, CameraFeedTrack>>
  onFrame?: (name: FrontCamera, live: boolean, track?: CameraFeedTrack) => void
}) {
  const [focused, setFocused] = useState(false)
  const [fullscreen, setFullscreen] = useState(false)
  return <section className={fullscreen ? 'fixed inset-0 z-50 flex flex-col bg-slate-950 p-4 pb-24 text-slate-100' : 'flex min-h-[300px] flex-col text-slate-100'}>
    <header className="mb-2 flex flex-wrap items-center justify-between gap-2 text-xs">
      <span>{vehicleId} · 三路独立画面 · 未拼接 · 无后视覆盖</span>
      <div className="flex gap-2">
        <button type="button" disabled={!tracks.center} onClick={() => setFocused(value => !value)} className="rounded border border-slate-700 px-3 py-2 disabled:opacity-40">{focused ? '恢复三路布局' : '放大中间'}</button>
        <button type="button" onClick={() => setFullscreen(value => !value)} className="rounded border border-slate-700 px-3 py-2">{fullscreen ? '退出全屏' : '全屏查看'}</button>
      </div>
    </header>
    <div className={`grid min-h-[260px] flex-1 gap-1 ${focused ? 'grid-cols-[minmax(0,2fr)_minmax(0,1fr)] grid-rows-2' : 'grid-cols-3'}`}
      style={fullscreen ? undefined : { aspectRatio: focused ? '16 / 9' : '16 / 6' }}>
      {frontCameras.map(camera => <div key={camera.name} className="flex min-h-0 min-w-0 [&>section]:flex-1"
        style={focused ? camera.name === 'center' ? { gridColumn: 1, gridRow: '1 / 3' }
          : { gridColumn: 2, gridRow: camera.name === 'left' ? 1 : 2 } : undefined}>
        <CameraSlot {...camera} track={tracks[camera.name]} onFrame={onFrame} />
      </div>)}
    </div>
  </section>
}
