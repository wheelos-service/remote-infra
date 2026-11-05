import { useEffect, useRef } from 'react'
import { HashRouter, Route, Routes, useLocation, useNavigate } from 'react-router'
import HomePage from './pages/Home'
import { MockFleetProvider } from './app/MockFleetProvider'
import { AuthProvider, useAuth } from './app/AuthProvider'
import Admin from './pages/Admin'
import OperationsPlatform from './pages/OperationsPlatform'

function PlatformRoutes() {
  const auth = useAuth()
  const location = useLocation()
  const navigate = useNavigate()
  const safeLocation = useRef(location)
  if (!auth.controlBusy) safeLocation.current = location
  useEffect(() => {
    if (auth.controlBusy && (location.pathname !== safeLocation.current.pathname ||
      location.search !== safeLocation.current.search || location.hash !== safeLocation.current.hash)) {
      navigate(safeLocation.current, { replace: true })
    }
  }, [auth.controlBusy, location, navigate])
  const preview = new URLSearchParams(window.location.search).get('preview') === '1'
  return <Routes location={auth.controlBusy ? safeLocation.current : location}>
    <Route path="/" element={preview
      ? <MockFleetProvider defaultEnabled><HomePage /></MockFleetProvider>
      : <OperationsPlatform />} />
    <Route path="/admin" element={<Admin />} />
  </Routes>
}

export default function App() {
  return (
    <HashRouter>
      <AuthProvider><PlatformRoutes /></AuthProvider>
    </HashRouter>
  )
}
