import { useEffect, useState } from 'react'
import { fetchVehicleData, VehicleDataError } from '../lib/vehicle-data-api'
import type { VehicleData } from '../lib/vehicle-data-api'

interface DataState {
  key?: string
  data?: VehicleData
  error?: string
  loading: boolean
  startedAt?: number
}

export function useVehicleData(vehicle: string, token: string | undefined, enabled: boolean) {
  const [state, setState] = useState<DataState>({ loading: false })
  const [revision, setRevision] = useState(0)
  const [now, setNow] = useState(() => performance.now())
  const key = enabled && token ? `${token}:${vehicle}` : undefined
  useEffect(() => {
    const timer = setInterval(() => setNow(performance.now()), 1000)
    return () => clearInterval(timer)
  }, [])
  useEffect(() => {
    if (!key || !token) {
      setState({ loading: false })
      return
    }
    let disposed = false
    let timer: ReturnType<typeof setTimeout> | undefined
    let request: AbortController | undefined
    setState((previous) => previous.key === key ? previous : { key, loading: true })
    const poll = async () => {
      request = new AbortController()
      const startedAt = performance.now()
      try {
        const data = await fetchVehicleData(vehicle, token, request.signal)
        if (!disposed) setState({ key, data, loading: false, startedAt })
      } catch (error) {
        if (!disposed) setState((previous) => ({
          ...(previous.key === key ? previous : {}), key, loading: false,
          error: error instanceof VehicleDataError ? error.message : '车辆数据读取失败',
        }))
      } finally {
        if (!disposed) timer = setTimeout(poll, 2000)
      }
    }
    void poll()
    return () => { disposed = true; clearTimeout(timer); request?.abort() }
  }, [vehicle, token, key, revision])
  const current = key && state.key === key ? state : { loading: Boolean(key) }
  return {
    ...current,
    elapsedMs: current.startedAt === undefined ? 0 : Math.max(0, Math.max(now, performance.now()) - current.startedAt),
    refresh: () => setRevision((value) => value + 1),
  }
}
