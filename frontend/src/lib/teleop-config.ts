export interface TeleopRuntimeConfig {
  gatewayUrl: string
  livekitUrl: string
  authorizeUrl: string
  tokenUrl: string
  clientId: string
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
}

const query = new URLSearchParams(window.location.search)
const isLocalDevelopment =
  ['localhost', '127.0.0.1', '[::1]'].includes(window.location.hostname) && query.get('dev') === '1'
const localGateway = query.get('backend')
const localLivekit = query.get('livekit')
const localOverrides: Partial<TeleopRuntimeConfig> = isLocalDevelopment
  ? {
      ...(localGateway ? { gatewayUrl: localGateway } : {}),
      ...(localLivekit ? { livekitUrl: localLivekit } : {}),
    }
  : {}

export const teleopConfig: TeleopRuntimeConfig = {
  ...defaults,
  ...localOverrides,
  ...window.__LIVEKIT_INFRA_CONFIG__,
}
