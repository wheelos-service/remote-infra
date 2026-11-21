import { useCallback, useEffect, useRef, useState } from 'react'
import { Room, RoomEvent, Track, type Participant, type RemoteParticipant, type RemoteTrackPublication, type RemoteVideoTrack, type TrackPublication } from 'livekit-client'
import { ViewingLifecycle } from '../lib/viewing-lifecycle'
import { newViewingId, isVehicleVideoSender } from '../lib/viewing-api'
import { teleopConfig } from '../lib/teleop-config'
import { trackCameraName } from '../lib/camera-view'
import { threeCamerasReady, type CameraFeedTrack } from '../lib/camera-feed'
import type { TeleopDiagnosticsBuffer } from '../lib/teleop-diagnostics'
import type { FrontCamera } from '../pages/ThreeCameraView'

type CameraTracks = Partial<Record<FrontCamera, RemoteVideoTrack>>
type CameraFailures = Partial<Record<FrontCamera, string>>

export function useDrivingCameras(
  vehicleId: string,
  bearer: string,
  recoverViewing = false,
  diagnostics?: TeleopDiagnosticsBuffer,
) {
  const [tracks, setTracks] = useState<CameraTracks>({})
  const [failedCameras, setFailedCameras] = useState<CameraFailures>({})
  const [connected, setConnected] = useState(false)
  const [recovering, setRecovering] = useState(false)
  const [error, setError] = useState('')
  const [playbackEpoch, setPlaybackEpoch] = useState<number>()
  const playbackRef = useRef<{ onFrame: (camera: FrontCamera, live: boolean, track: CameraFeedTrack) => void } | undefined>(undefined)
  const reportFrame = useCallback((camera: FrontCamera, live: boolean, track?: CameraFeedTrack) => {
    if (track) playbackRef.current?.onFrame(camera, live, track)
  }, [])
  useEffect(() => {
    let disposed = false
    let frameEpoch = 0
    let observerEpoch = 0
    const rendered = new Set<FrontCamera>()
    let activeTracks: CameraTracks = {}
    let activeFailures: CameraFailures = {}
    const updateTracks = (next: CameraTracks) => {
      activeTracks = next
      setTracks(next)
    }
    const updateFailures = (next: CameraFailures) => {
      activeFailures = next
      setFailedCameras(next)
    }
    const clearFailure = (name: FrontCamera) => {
      if (!(name in activeFailures)) return
      const next = { ...activeFailures }
      delete next[name]
      updateFailures(next)
    }
    const removeTrack = (track?: Track) => {
      if (track) updateTracks(Object.fromEntries(Object.entries(activeTracks).filter(([, value]) => value !== track)))
    }
    setTracks({})
    setFailedCameras({})
    playbackRef.current = undefined
    setPlaybackEpoch(undefined)
    setConnected(false)
    setRecovering(false)
    setError('')
    const failure = (cause: unknown) => {
      if (disposed) return
      updateTracks({})
      updateFailures({})
      playbackRef.current = undefined
      setConnected(false)
      setRecovering(false)
      setError(cause instanceof Error ? cause.message : '视频连接失败')
    }
    const lifecycle = new ViewingLifecycle({
      vehicleId, bearer, clientInstanceId: newViewingId(),
      createObserver: (token, events) => {
        if (++observerEpoch > 1 && !disposed) {
          rendered.clear()
          updateTracks({})
          updateFailures({})
          setPlaybackEpoch(frameEpoch)
        }
        const observer = new Room({ adaptiveStream: false, dynacast: false })
        let acceptTracks = true
        const current = () => !disposed && events.current() && acceptTracks
        const addTrack = (track: Track, publication: TrackPublication, participant: Participant) => {
          if (!current() || !isVehicleVideoSender(participant.identity, vehicleId) ||
              track.kind !== Track.Kind.Video || publication.isMuted || publication.track !== track ||
              participant.trackPublications.get(publication.trackSid) !== publication) return
          const name = trackCameraName(publication.trackName)
          if (name === 'left' || name === 'center' || name === 'right') {
            clearFailure(name)
            if (activeTracks[name] !== track) {
              updateTracks({ ...activeTracks, [name]: track as RemoteVideoTrack })
            }
          }
        }
        const subscribe = (publication: RemoteTrackPublication, participant: RemoteParticipant) => {
          if (!current()) return
          const camera = trackCameraName(publication.trackName)
          if (isVehicleVideoSender(participant.identity, vehicleId) &&
              (camera === 'left' || camera === 'center' || camera === 'right')) {
            publication.setSubscribed(true)
            if (publication.track) addTrack(publication.track, publication, participant)
          }
        }
        const subscribeExisting = () => {
          for (const participant of observer.remoteParticipants.values()) {
            for (const publication of participant.trackPublications.values()) subscribe(publication, participant)
          }
        }
        observer.on(RoomEvent.TrackPublished, subscribe)
        observer.on(RoomEvent.TrackSubscribed, addTrack)
        observer.on(RoomEvent.TrackUnsubscribed, track => {
          if (!current()) return
          removeTrack(track)
        })
        observer.on(RoomEvent.TrackMuted, publication => {
          if (!current()) return
          removeTrack(publication.track)
        })
        observer.on(RoomEvent.TrackUnmuted, (publication, participant) => {
          if (publication.track) addTrack(publication.track, publication, participant)
        })
        observer.on(RoomEvent.TrackSubscriptionFailed, (trackSid, participant) => {
          if (!current()) return
          if (!recoverViewing) {
            lifecycle.fail(new Error('相机订阅失败；请重新连接监看'))
            return
          }
          const publication = participant.trackPublications.get(trackSid)
          const camera = publication ? trackCameraName(publication.trackName) : undefined
          if (camera === 'left' || camera === 'center' || camera === 'right') {
            updateFailures({ ...activeFailures, [camera]: '订阅失败' })
            diagnostics?.record('video', 'camera_subscription_failed', camera)
          }
          console.warn('相机订阅失败；该路画面不可用')
        })
        observer.on(RoomEvent.Reconnecting, () => {
          acceptTracks = false
          diagnostics?.record('video', 'room_reconnecting')
          events.reconnecting()
        })
        observer.on(RoomEvent.Reconnected, () => {
          acceptTracks = true
          updateFailures({})
          diagnostics?.record('video', 'room_reconnected')
          events.reconnected()
          subscribeExisting()
        })
        observer.on(RoomEvent.Disconnected, () => {
          diagnostics?.record('video', 'room_disconnected')
          events.disconnected()
        })
        return {
          connect: async () => {
            await observer.connect(teleopConfig.livekitUrl, token, { autoSubscribe: false })
            subscribeExisting()
          },
          disconnect: () => {
            observer.removeAllListeners()
            return observer.disconnect()
          },
        }
      },
      onRecovering: recoverViewing ? () => {
        if (disposed) return
        const id = ++frameEpoch
        rendered.clear()
        setConnected(false)
        setRecovering(true)
        playbackRef.current = { onFrame: (camera, live, track) => {
          if (disposed || id !== frameEpoch || activeTracks[camera] !== track) return
          if (!live) {
            rendered.delete(camera)
            return
          }
          rendered.add(camera)
          if (threeCamerasReady(Object.fromEntries(
            (['left', 'center', 'right'] as const).map(name => [name, rendered.has(name) && Boolean(activeTracks[name])]),
          ))) {
            lifecycle.frameRendered()
          }
        } }
      } : undefined,
      onConnected: () => {
        if (disposed) return
        diagnostics?.record('video', 'video_connected')
        setConnected(true)
        setRecovering(false)
      },
      onError: cause => {
        diagnostics?.record('video', 'video_failed')
        failure(cause)
      },
      onCleanupError: () => {
        console.error('监看资源清理失败')
      },
    })
    const leave = (event: PageTransitionEvent) => {
      if (recoverViewing) lifecycle.fail(new Error('已离开页面，请重新申请监看'))
      else if (!event.persisted) void lifecycle.stop()
    }
    window.addEventListener('pagehide', leave)
    void lifecycle.start()
    return () => {
      disposed = true
      window.removeEventListener('pagehide', leave)
      void lifecycle.stop()
    }
  }, [vehicleId, bearer, recoverViewing, diagnostics])
  return { tracks, failedCameras, connected, recovering, error, playbackEpoch, reportFrame }
}
