export interface TeleopRuntimeConfig {
  gatewayUrl: string
  livekitUrl: string
  authorizeUrl: string
  tokenUrl: string
  clientId: string
  controlLongitudinalMode?: 'throttle' | 'speed'
  maxRemoteSpeedMps?: number
}

declare global {
  interface Window {
    __LIVEKIT_INFRA_CONFIG__?: Partial<TeleopRuntimeConfig>
  }
}

const defaults: TeleopRuntimeConfig = {
  gatewayUrl: window.location.origin ?? '',
  livekitUrl: (window.location.origin ?? '').replace(/^http/, 'ws'),
  authorizeUrl: '',
  tokenUrl: '',
  clientId: '',
  controlLongitudinalMode: 'throttle',
  maxRemoteSpeedMps: 5,
}

const query = new URLSearchParams(window.location.search)
const isLocalDevelopment =
  ['localhost', '127.0.0.1', '[::1]'].includes(window.location.hostname) && query.get('dev') === '1'
const localGateway = query.get('backend')
const localLivekit = query.get('livekit')
const localLongitudinal = query.get('longitudinal')
const localMaxSpeed = Number(query.get('maxSpeed'))
const localOverrides: Partial<TeleopRuntimeConfig> = isLocalDevelopment
  ? {
      ...(localGateway ? { gatewayUrl: localGateway } : {}),
      ...(localLivekit ? { livekitUrl: localLivekit } : {}),
      ...(localLongitudinal === 'throttle' || localLongitudinal === 'speed'
        ? { controlLongitudinalMode: localLongitudinal }
        : {}),
      ...(Number.isFinite(localMaxSpeed) && localMaxSpeed > 0 && localMaxSpeed <= 30
        ? { maxRemoteSpeedMps: localMaxSpeed }
        : {}),
    }
  : {}

const merged: TeleopRuntimeConfig = {
  ...defaults,
  ...localOverrides,
  ...window.__LIVEKIT_INFRA_CONFIG__,
}

export const teleopConfig: TeleopRuntimeConfig = {
  ...merged,
  controlLongitudinalMode: merged.controlLongitudinalMode === 'speed' ? 'speed' : 'throttle',
  maxRemoteSpeedMps: typeof merged.maxRemoteSpeedMps === 'number' &&
    Number.isFinite(merged.maxRemoteSpeedMps) && merged.maxRemoteSpeedMps > 0 && merged.maxRemoteSpeedMps <= 30
    ? merged.maxRemoteSpeedMps : 5,
}
