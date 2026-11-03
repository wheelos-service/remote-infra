import { useRef } from 'react'
import { useLocation, useNavigate } from 'react-router'
import { defaultNavigation, navigationSearch, readNavigation, type OperationsNavigation } from '../lib/operations-navigation'

export function useOperationsNavigation() {
  const location = useLocation()
  const navigate = useNavigate()
  const result = readNavigation(location.search)
  const state = result.success ? result.data : defaultNavigation
  const pending = useRef({ state, scheduled: false, replace: true })
  if (!pending.current.scheduled) pending.current.state = state
  const update = (patch: Partial<OperationsNavigation>, replace = false) => {
    pending.current.state = { ...pending.current.state, ...patch }
    pending.current.replace = pending.current.scheduled ? pending.current.replace && replace : replace
    if (pending.current.scheduled) return
    pending.current.scheduled = true
    // A cross-page action can set vehicle, view and page together: keep one history entry.
    queueMicrotask(() => {
      const next = pending.current
      next.scheduled = false
      const search = navigationSearch(next.state)
      navigate({ pathname: '/', search: search ? `?${search}` : '' }, { replace: next.replace })
    })
  }
  return { state, update, error: result.success ? null : '页面地址参数无效，请返回车队总览。' }
}
