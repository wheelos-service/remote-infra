import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import { teleopConfig } from '../lib/teleop-config'

export interface OperatorClaims {
  Name?: string
  Roles?: string[]
  Organization?: string
}

interface AuthContextValue {
  accessToken?: string
  operator?: OperatorClaims
  loading: boolean
  error?: string
  isDevLoginAvailable: boolean
  signIn: () => Promise<void>
  signInWithDevToken: () => Promise<void>
  signOut: () => void
}

const AuthContext = createContext<AuthContextValue | undefined>(undefined)

function redirectUri(): string {
  return `${window.location.origin}${window.location.pathname}`
}

function randomBase64Url(byteLength: number): string {
  const bytes = crypto.getRandomValues(new Uint8Array(byteLength))
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

async function makeCodeChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))
  const bytes = new Uint8Array(digest)
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function isLocalHost(): boolean {
  return ['localhost', '127.0.0.1', '[::1]'].includes(window.location.hostname)
}

async function responseError(response: Response): Promise<Error> {
  const detail = (await response.text()).trim()
  return new Error(detail || `请求失败 (${response.status})`)
}

async function validateAccessToken(token: string): Promise<OperatorClaims> {
  const response = await fetch(`${teleopConfig.gatewayUrl.replace(/\/$/, '')}/api/auth/me`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  if (!response.ok) throw await responseError(response)
  const claims = (await response.json()) as OperatorClaims
  if (!claims.Name) throw new Error('网关未返回有效的操作员身份')
  return claims
}

export const AuthProvider: React.FC<React.PropsWithChildren> = ({ children }) => {
  const [accessToken, setAccessToken] = useState<string>()
  const [operator, setOperator] = useState<OperatorClaims>()
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string>()
  const isDevLoginAvailable = isLocalHost() && new URLSearchParams(window.location.search).get('dev') === '1'

  const acceptToken = useCallback(async (token: string) => {
    const claims = await validateAccessToken(token)
    setAccessToken(token)
    setOperator(claims)
    setError(undefined)
  }, [])

  useEffect(() => {
    let cancelled = false

    const initialize = async () => {
      if (new URLSearchParams(window.location.search).get('preview') === '1') {
        setLoading(false)
        return
      }
      try {
        const callback = new URLSearchParams(window.location.search)
        const oauthError = callback.get('error')
        if (oauthError) {
          sessionStorage.removeItem('teleop.oidc.state')
          sessionStorage.removeItem('teleop.oidc.verifier')
          throw new Error(callback.get('error_description') || '单点登录失败')
        }

        const code = callback.get('code')
        if (!code) return

        const expectedState = sessionStorage.getItem('teleop.oidc.state')
        const verifier = sessionStorage.getItem('teleop.oidc.verifier')
        sessionStorage.removeItem('teleop.oidc.state')
        sessionStorage.removeItem('teleop.oidc.verifier')
        if (!expectedState || !verifier || callback.get('state') !== expectedState) {
          throw new Error('登录状态校验失败，请重新登录')
        }

        const response = await fetch(teleopConfig.tokenUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            grant_type: 'authorization_code',
            client_id: teleopConfig.clientId,
            code,
            redirect_uri: redirectUri(),
            code_verifier: verifier,
          }),
        })
        if (!response.ok) throw await responseError(response)
        const tokenResponse = (await response.json()) as { access_token?: string }
        if (!tokenResponse.access_token) throw new Error('登录响应中未包含访问令牌')

        const claims = await validateAccessToken(tokenResponse.access_token)
        if (cancelled) return
        setAccessToken(tokenResponse.access_token)
        setOperator(claims)
        window.history.replaceState({}, document.title, `${redirectUri()}${window.location.hash}`)
      } catch (cause) {
        if (!cancelled) {
          setError(cause instanceof Error ? cause.message : '登录状态校验失败')
        }
      } finally {
        if (!cancelled) setLoading(false)
      }
    }

    void initialize()
    return () => {
      cancelled = true
    }
  }, [])

  const signIn = useCallback(async () => {
    if (new URLSearchParams(window.location.search).get('preview') === '1') return
    setError(undefined)
    try {
      const verifier = randomBase64Url(32)
      const state = randomBase64Url(24)
      sessionStorage.setItem('teleop.oidc.verifier', verifier)
      sessionStorage.setItem('teleop.oidc.state', state)
      const query = new URLSearchParams({
        response_type: 'code',
        client_id: teleopConfig.clientId,
        redirect_uri: redirectUri(),
        scope: 'openid profile teleop:observe',
        state,
        code_challenge: await makeCodeChallenge(verifier),
        code_challenge_method: 'S256',
      })
      window.location.assign(`${teleopConfig.authorizeUrl}?${query}`)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '无法启动登录流程')
    }
  }, [])

  const signInWithDevToken = useCallback(async () => {
    if (new URLSearchParams(window.location.search).get('preview') === '1') return
    if (!isDevLoginAvailable) {
      setError('开发令牌登录仅允许在本机 localhost 且 URL 带 dev=1 时使用')
      return
    }
    const token = window.prompt('输入本地开发环境的操作员令牌')
    if (!token) return
    try {
      await acceptToken(token)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '开发令牌校验失败')
    }
  }, [acceptToken, isDevLoginAvailable])

  const signOut = useCallback(() => {
    setAccessToken(undefined)
    setOperator(undefined)
    setError(undefined)
  }, [])

  const value = useMemo<AuthContextValue>(
    () => ({
      accessToken,
      operator,
      loading,
      error,
      isDevLoginAvailable,
      signIn,
      signInWithDevToken,
      signOut,
    }),
    [accessToken, operator, loading, error, isDevLoginAvailable, signIn, signInWithDevToken, signOut],
  )

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext)
  if (!context) throw new Error('useAuth must be used within AuthProvider')
  return context
}
