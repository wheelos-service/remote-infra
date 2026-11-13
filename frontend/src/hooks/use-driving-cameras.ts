import { useEffect, useState } from 'react'
import { Room, RoomEvent, Track, type RemoteParticipant, type RemoteTrackPublication, type RemoteVideoTrack } from 'livekit-client'
import { ViewingLifecycle } from '../lib/viewing-lifecycle'
import { newViewingId, isVehicleVideoSender } from '../lib/viewing-api'
import { teleopConfig } from '../lib/teleop-config'
import { trackCameraName } from '../lib/camera-view'
import { createFrameMetadataWorker, watchFrameMetadataWorker } from '../lib/frame-metadata-worker'
import type { FrontCamera } from '../pages/ThreeCameraView'

export function useDrivingCameras(vehicleId: string, bearer: string) {
  const [tracks, setTracks] = useState<Partial<Record<FrontCamera, RemoteVideoTrack>>>({})
  const [connected, setConnected] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => {
    let disposed = false
    let room: Room | undefined
    setTracks({})
    setConnected(false)
    setError('')
    const failure = (cause: unknown) => {
      if (disposed) return
      setTracks({})
      setConnected(false)
      setError(cause instanceof Error ? cause.message : '视频连接失败')
    }
    const lifecycle = new ViewingLifecycle({
      vehicleId, bearer, clientInstanceId: newViewingId(),
      createObserver: (token) => {
        let cancelled = false
        let worker: Worker | undefined
        let unwatchWorker: (() => void) | undefined
        let observer: Room | undefined
        const connect = async () => {
          worker = await createFrameMetadataWorker()
          if (cancelled || disposed || !lifecycle.active) { worker?.terminate(); return }
          if (worker) unwatchWorker = watchFrameMetadataWorker(worker, lifecycle, () => cancelled || disposed)
          try {
            observer = new Room({ adaptiveStream: false, dynacast: false,
              ...(worker ? { frameMetadata: { worker } } : {}) })
          } catch (error) {
            unwatchWorker?.()
            worker?.terminate()
            throw error
          }
          room = observer
          const subscribe = (publication: RemoteTrackPublication, participant: RemoteParticipant) => {
            const camera = trackCameraName(publication.trackName)
            if (isVehicleVideoSender(participant.identity, vehicleId) &&
                (camera === 'left' || camera === 'center' || camera === 'right')) {
              publication.setSubscribed(true)
            }
          }
          observer.on(RoomEvent.TrackPublished, subscribe)
          observer.on(RoomEvent.TrackSubscribed, (track, publication, participant) => {
            if (disposed || !lifecycle.active || !isVehicleVideoSender(participant.identity, vehicleId) || track.kind !== Track.Kind.Video) return
            const name = trackCameraName(publication.trackName)
            if (name === 'left' || name === 'center' || name === 'right') {
              setTracks(previous => ({ ...previous, [name]: track as RemoteVideoTrack }))
            }
          })
          observer.on(RoomEvent.TrackUnsubscribed, track => {
            if (disposed) return
            setTracks(previous => Object.fromEntries(Object.entries(previous).filter(([, value]) => value !== track)))
          })
          observer.on(RoomEvent.TrackMuted, publication => {
            if (disposed) return
            setTracks(previous => Object.fromEntries(Object.entries(previous).filter(([, value]) => value !== publication.track)))
          })
          observer.on(RoomEvent.TrackUnmuted, (publication, participant) => {
            if (disposed || !lifecycle.active || !isVehicleVideoSender(participant.identity, vehicleId)) return
            const name = trackCameraName(publication.trackName)
            if ((name === 'left' || name === 'center' || name === 'right') && publication.track?.kind === Track.Kind.Video) {
              setTracks(previous => ({ ...previous, [name]: publication.track as RemoteVideoTrack }))
            }
          })
          observer.on(RoomEvent.TrackSubscriptionFailed, () => lifecycle.fail(new Error('相机订阅失败；请重新连接监看')))
          observer.on(RoomEvent.Reconnecting, () => lifecycle.fail(new Error('视频连接中断；必须重新连接监看和申请控制')))
          observer.on(RoomEvent.Disconnected, () => {
            if (!disposed && lifecycle.active) lifecycle.fail(new Error('视频已断开'))
          })
          await observer.connect(teleopConfig.livekitUrl, token, { autoSubscribe: false })
          if (!lifecycle.active || disposed) return
          for (const participant of observer.remoteParticipants.values()) {
            for (const publication of participant.trackPublications.values()) subscribe(publication, participant)
          }
        }
        return {
          connect,
          disconnect: async () => {
            cancelled = true
            unwatchWorker?.()
            try {
              const disconnecting = observer?.disconnect()
              worker?.terminate()
              await disconnecting
            } finally { worker?.terminate() }
          },
        }
      },
      onConnected: () => { if (!disposed) setConnected(true) },
      onError: failure,
      onCleanupError: () => {
        console.error('监看资源释放失败；租约将按 TTL 失效')
        if (!disposed) setError('监看资源释放失败；租约将按 TTL 失效')
      },
    })
    const hidden = () => { if (document.hidden) lifecycle.fail(new Error('页面隐藏，监看已停止')) }
    const leave = () => { void lifecycle.stop() }
    document.addEventListener('visibilitychange', hidden)
    window.addEventListener('pagehide', leave)
    void lifecycle.start()
    return () => {
      disposed = true
      document.removeEventListener('visibilitychange', hidden)
      window.removeEventListener('pagehide', leave)
      void lifecycle.stop()
      room?.removeAllListeners()
    }
  }, [vehicleId, bearer])
  return { tracks, connected, error }
}
