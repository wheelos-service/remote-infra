import { useCallback, useEffect, useRef, useState } from 'react'
import { DisconnectReason, Room, RoomEvent, Track, type Participant, type RemoteParticipant, type RemoteTrackPublication, type RemoteVideoTrack, type TrackPublication } from 'livekit-client'
import { ViewingLifecycle } from '../lib/viewing-lifecycle'
import { newViewingId, isVehicleVideoSender } from '../lib/viewing-api'
import { teleopConfig } from '../lib/teleop-config'
import { isSingleFront, trackCameraName } from '../lib/camera-view'
import type { CameraFeedTrack } from '../lib/camera-feed'
import type { TeleopDiagnosticsBuffer } from '../lib/teleop-diagnostics'
import type { FrontCamera } from '../pages/ThreeCameraView'

type CameraTracks = Partial<Record<FrontCamera, RemoteVideoTrack>>
type CameraFailures = Partial<Record<FrontCamera, string>>

function isSupportedCamera(name?: string): name is FrontCamera {
  return name === 'front' || name === 'left' || name === 'center' || name === 'right'
}

export function useDrivingCameras(
  vehicleId: string,
  bearer: string,
  recoverViewing = false,
  diagnostics?: TeleopDiagnosticsBuffer,
) {
  const [tracks, setTracks] = useState<CameraTracks>({})
  const [failedCameras, setFailedCameras] = useState<CameraFailures>({})
  const [frames, setFrames] = useState<Partial<Record<FrontCamera, CameraFeedTrack>>>({})
  const [connected, setConnected] = useState(false)
  const [recovering, setRecovering] = useState(false)
  const [signalRecovering, setSignalRecovering] = useState(false)
  const [error, setError] = useState('')
  const [playbackEpoch, setPlaybackEpoch] = useState<number>()
  const playbackRef = useRef<{
    onFrame: (camera: FrontCamera, live: boolean, track: CameraFeedTrack) => void
    onProgress: (camera: FrontCamera, track: CameraFeedTrack) => void
  } | undefined>(undefined)
  const reportFrame = useCallback((camera: FrontCamera, live: boolean, track?: CameraFeedTrack) => {
    if (track) playbackRef.current?.onFrame(camera, live, track)
  }, [])
  const reportProgress = useCallback((camera: FrontCamera, track: CameraFeedTrack) => {
    playbackRef.current?.onProgress(camera, track)
  }, [])
  useEffect(() => {
    let disposed = false
    let frameEpoch = 0
    let observerEpoch = 0
    let transportConnected = false
    let activeTracks: CameraTracks = {}
    let activeFailures: CameraFailures = {}
    let activeFrames: Partial<Record<FrontCamera, CameraFeedTrack>> = {}
    const updateFrames = (next: Partial<Record<FrontCamera, CameraFeedTrack>>) => {
      activeFrames = next
      setFrames(next)
    }
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
      if (!track) return
      updateFrames(Object.fromEntries(Object.entries(activeFrames).filter(([, value]) => value !== track)))
      updateTracks(Object.fromEntries(Object.entries(activeTracks).filter(([, value]) => value !== track)))
    }
    setTracks({})
    setFailedCameras({})
    setFrames({})
    playbackRef.current = {
      onFrame: (camera, live, track) => {
        if (disposed) return
        if (!live && activeFrames[camera] === track) {
          const next = { ...activeFrames }
          delete next[camera]
          updateFrames(next)
          diagnostics?.record('video', 'camera_stalled', camera)
        }
      },
      onProgress: (camera, track) => {
        if (disposed || !transportConnected || activeTracks[camera] !== track ||
            (camera === 'front') !== isSingleFront(activeTracks)) return
        if (activeFrames[camera] !== track) {
          updateFrames({ ...activeFrames, [camera]: track })
          diagnostics?.record('video', 'camera_live', camera)
        }
        lifecycle.frameRendered()
      },
    }
    setPlaybackEpoch(undefined)
    setConnected(false)
    setRecovering(false)
    setSignalRecovering(false)
    setError('')
    const failure = (cause: unknown) => {
      if (disposed) return
      transportConnected = false
      updateTracks({})
      updateFailures({})
      updateFrames({})
      playbackRef.current = undefined
      setConnected(false)
      setRecovering(false)
      setSignalRecovering(false)
      setError(cause instanceof Error ? cause.message : '视频连接失败')
    }
    const lifecycle = new ViewingLifecycle({
      vehicleId, bearer, clientInstanceId: newViewingId(),
      createObserver: (token, events) => {
        if (++observerEpoch > 1 && !disposed) {
          updateTracks({})
          updateFailures({})
          updateFrames({})
          setPlaybackEpoch(frameEpoch)
        }
        const worker = typeof Worker !== 'undefined' &&
          ('RTCRtpScriptTransform' in window || (typeof RTCRtpReceiver !== 'undefined' && 'createEncodedStreams' in RTCRtpReceiver.prototype))
          ? new Worker('/frame-metadata-worker.js') : undefined
        const observer = new Room({ adaptiveStream: false, dynacast: false,
          frameMetadata: worker ? { worker } : undefined })
        let acceptTracks = true
        const retryCounts = new Map<string, number>()
        const retryTimers = new Set<ReturnType<typeof setTimeout>>()
        const clearRetryTimers = () => {
          for (const timer of retryTimers) clearTimeout(timer)
          retryTimers.clear()
        }
        const current = () => !disposed && events.current() && acceptTracks
        const addTrack = (track: Track, publication: TrackPublication, participant: Participant) => {
          if (!current() || !isVehicleVideoSender(participant.identity, vehicleId) ||
              track.kind !== Track.Kind.Video || publication.isMuted || publication.track !== track ||
              participant.trackPublications.get(publication.trackSid) !== publication) return
          const name = trackCameraName(publication.trackName)
          if (isSupportedCamera(name)) {
            retryCounts.delete(publication.trackSid)
            clearFailure(name)
            if (activeTracks[name] !== track) {
              updateTracks({ ...activeTracks, [name]: track as RemoteVideoTrack })
            }
          }
        }
        const subscribe = (publication: RemoteTrackPublication, participant: RemoteParticipant) => {
          if (!current()) return
          const camera = trackCameraName(publication.trackName)
          if (isVehicleVideoSender(participant.identity, vehicleId) && isSupportedCamera(camera)) {
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
          if (!current() || !isVehicleVideoSender(participant.identity, vehicleId)) return
          if (!recoverViewing) {
            lifecycle.fail(new Error('相机订阅失败；请重新连接监看'))
            return
          }
          const publication = participant.trackPublications.get(trackSid)
          const camera = publication ? trackCameraName(publication.trackName) : undefined
          if (isSupportedCamera(camera)) {
            updateFailures({ ...activeFailures, [camera]: '订阅失败' })
            diagnostics?.record('video', 'camera_subscription_failed', camera)
            const attempt = (retryCounts.get(trackSid) ?? 0) + 1
            if (attempt <= 3 && publication instanceof Object && 'setSubscribed' in publication) {
              retryCounts.set(trackSid, attempt)
              const timer = setTimeout(() => {
                retryTimers.delete(timer)
                if (!current() || participant.trackPublications.get(trackSid) !== publication ||
                    publication.isMuted) return
                const remotePub = publication as RemoteTrackPublication
                remotePub.setSubscribed(false)
                remotePub.setSubscribed(true)
              }, 500 * 2 ** (attempt - 1))
              retryTimers.add(timer)
            }
          }
          console.warn('相机订阅失败；该路画面不可用')
        })
        observer.on(RoomEvent.Reconnecting, () => {
          if (disposed || !events.current()) return
          acceptTracks = false
          clearRetryTimers()
          diagnostics?.record('video', 'room_reconnecting')
          events.reconnecting()
        })
        observer.on(RoomEvent.SignalReconnecting, () => {
          if (disposed || !events.current()) return
          setSignalRecovering(true)
          diagnostics?.record('video', 'signal_reconnecting')
        })
        observer.on(RoomEvent.Reconnected, () => {
          if (disposed || !events.current()) return
          acceptTracks = true
          setSignalRecovering(false)
          updateFailures({})
          const present = new Set<Track>()
          for (const participant of observer.remoteParticipants.values()) {
            if (!isVehicleVideoSender(participant.identity, vehicleId)) continue
            for (const publication of participant.trackPublications.values()) {
              if (publication.track && !publication.isMuted) present.add(publication.track)
            }
          }
          const prunedEntries = Object.entries(activeTracks).filter(([, track]) => track && present.has(track))
          if (prunedEntries.length !== Object.keys(activeTracks).length) {
            updateTracks(Object.fromEntries(prunedEntries))
          }
          diagnostics?.record('video', 'room_reconnected')
          events.reconnected()
          subscribeExisting()
        })
        observer.on(RoomEvent.Disconnected, reason => {
          if (disposed || !events.current()) return
          diagnostics?.record('video', 'room_disconnected')
          events.disconnected(reason === DisconnectReason.CLIENT_INITIATED ||
            reason === DisconnectReason.DUPLICATE_IDENTITY ||
            reason === DisconnectReason.PARTICIPANT_REMOVED ||
            reason === DisconnectReason.ROOM_DELETED || reason === DisconnectReason.ROOM_CLOSED)
        })
        return {
          connect: async () => {
            await observer.connect(teleopConfig.livekitUrl, token, { autoSubscribe: false })
            subscribeExisting()
          },
          disconnect: () => {
            clearRetryTimers()
            observer.removeAllListeners()
            return observer.disconnect().finally(() => worker?.terminate())
          },
        }
      },
      onRecovering: recoverViewing ? () => {
        if (disposed) return
        ++frameEpoch
        transportConnected = false
        updateFrames({})
        setConnected(false)
        setRecovering(true)
        setSignalRecovering(false)
      } : undefined,
      onConnected: () => {
        if (disposed) return
        transportConnected = true
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
  return { tracks, frames, failedCameras, connected, recovering, signalRecovering, error, playbackEpoch, reportFrame, reportProgress }
}
