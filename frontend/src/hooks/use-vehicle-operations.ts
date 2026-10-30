import { useEffect, useState } from 'react'
import {
  fetchVehicleOperations,
  OPERATIONS_POLL_INTERVAL_MS,
  VehicleOperationsApiError,
} from '../lib/vehicle-operations-api'
import type { VehicleOperations } from '../lib/vehicle-operations-api'

export type OperationsStatus = 'disabled' | 'loading' | 'ready' | 'error'

export interface VehicleOperationsState {
  vehicleId?: string
  scopeKey?: string
  data?: VehicleOperations
  status: OperationsStatus
  error?: string
  updatedAtWallMs?: number
  requestStartedAtMs?: number
  nowMs?: number
}

const disabledState: VehicleOperationsState = { status: 'disabled' }

export function useVehicleOperations(
  vehicleId: string | undefined,
  accessToken: string | undefined,
  enabled = true,
): VehicleOperationsState {
  const [state, setState] = useState<VehicleOperationsState>(disabledState)
  const [nowMs, setNowMs] = useState(() => performance.now())
  const key = accessToken && enabled && vehicleId ? `${accessToken}:${vehicleId}` : undefined

  useEffect(() => {
    const timer = window.setInterval(() => setNowMs(performance.now()), 1_000)
    return () => window.clearInterval(timer)
  }, [])

  useEffect(() => {
    if (!key || !vehicleId || !accessToken) {
      setState(disabledState)
      return
    }

    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    let controller: AbortController | undefined
    setState({ vehicleId, scopeKey: key, status: 'loading' })

    const poll = async () => {
      const request = new AbortController()
      controller = request
      const requestStartedAtMs = performance.now()
      try {
        const data = await fetchVehicleOperations(vehicleId, accessToken, request.signal)
        if (cancelled || request.signal.aborted) return
        setState({
          vehicleId,
          scopeKey: key,
          data,
          status: 'ready',
          updatedAtWallMs: Date.now(),
          requestStartedAtMs,
        })
      } catch (error) {
        if (cancelled || request.signal.aborted) return
        setState((previous) => ({
          vehicleId,
          scopeKey: key,
          data: previous.vehicleId === vehicleId ? previous.data : undefined,
          status: 'error',
          error: error instanceof VehicleOperationsApiError
            ? error.message
            : '获取车辆业务数据失败',
          updatedAtWallMs: previous.vehicleId === vehicleId ? previous.updatedAtWallMs : undefined,
          requestStartedAtMs: previous.vehicleId === vehicleId
            ? previous.requestStartedAtMs
            : undefined,
        }))
      } finally {
        if (!cancelled) timer = setTimeout(poll, OPERATIONS_POLL_INTERVAL_MS)
      }
    }

    void poll()
    return () => {
      cancelled = true
      if (timer !== undefined) clearTimeout(timer)
      controller?.abort()
    }
  }, [key, vehicleId, accessToken])

  if (!key) return { ...disabledState, nowMs }
  if (state.vehicleId !== vehicleId || state.scopeKey !== key) return { vehicleId, status: 'loading', nowMs }
  return { ...state, nowMs }
}
