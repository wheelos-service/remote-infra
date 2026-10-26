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
  gatewayUrl: 'https://gateway.wheelos.cn',
  livekitUrl: 'wss://rtc.wheelos.cn',
  authorizeUrl: 'https://casdoor.wheelos.cn/login/oauth/authorize',
  tokenUrl: 'https://casdoor.wheelos.cn/api/login/oauth/access_token',
  clientId: 'cfeff3105319b0ac309b',
}

const query = new URLSearchParams(window.location.search)
const isLocalDevelopment =
  ['localhost', '127.0.0.1', '[::1]'].includes(window.location.hostname) && query.get('dev') === '1'
const localOverrides: Partial<TeleopRuntimeConfig> = isLocalDevelopment
  ? {
      gatewayUrl: query.get('backend') || undefined,
      livekitUrl: query.get('livekit') || undefined,
    }
  : {}

export const teleopConfig: TeleopRuntimeConfig = {
  ...defaults,
  ...localOverrides,
  ...window.__LIVEKIT_INFRA_CONFIG__,
}
