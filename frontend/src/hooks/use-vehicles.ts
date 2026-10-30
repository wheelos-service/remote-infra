import { useEffect, useRef, useState } from 'react'
import {
  fetchVehicles,
  VehiclesApiError,
  type VehicleDirectoryEntry,
} from '../lib/vehicles-api'
import type { ReceivedVehicle } from '../lib/vehicle-telemetry'

export const VEHICLES_POLL_INTERVAL_MS = 2_000

export type VehiclesStatus = 'signed-out' | 'loading' | 'ready' | 'error'

export interface VehiclesState {
  entries: ReceivedVehicle[]
  status: VehiclesStatus
  error?: string
  updatedAtWallMs?: number
  requestFailed: boolean
}

const initialState: VehiclesState = {
  entries: [],
  status: 'signed-out',
  requestFailed: false,
}

export function useVehicles(accessToken?: string): VehiclesState {
  const [state, setState] = useState<VehiclesState>(initialState)
  const stateTokenRef = useRef<string | undefined>(undefined)

  useEffect(() => {
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    let activeController: AbortController | undefined

    if (!accessToken) {
      stateTokenRef.current = undefined
      setState(initialState)
      return () => {
        cancelled = true
      }
    }

    stateTokenRef.current = accessToken
    setState({ ...initialState, status: 'loading' })

    const poll = async () => {
      const controller = new AbortController()
      activeController = controller
      const receivedAtClientMs = performance.now()
      try {
        const entries: VehicleDirectoryEntry[] = await fetchVehicles(accessToken, controller.signal)
        if (cancelled || controller.signal.aborted) return
        const receivedAtWallMs = Date.now()
        setState({
          entries: entries.map((entry) => ({
            ...entry,
            receivedAtClientMs,
            receivedAtWallMs,
          })),
          status: 'ready',
          updatedAtWallMs: receivedAtWallMs,
          requestFailed: false,
        })
      } catch (error) {
        if (cancelled || controller.signal.aborted) return
        const message =
          error instanceof VehiclesApiError ? error.message : '获取车辆目录失败'
        setState((previous) => ({
          ...previous,
          status: 'error',
          error: message,
          requestFailed: true,
        }))
      } finally {
        if (!cancelled) timer = setTimeout(poll, VEHICLES_POLL_INTERVAL_MS)
      }
    }

    void poll()
    return () => {
      cancelled = true
      if (timer !== undefined) clearTimeout(timer)
      activeController?.abort()
    }
  }, [accessToken])

  if (stateTokenRef.current !== accessToken) {
    return accessToken ? { ...initialState, status: 'loading' } : initialState
  }
  return state
}
