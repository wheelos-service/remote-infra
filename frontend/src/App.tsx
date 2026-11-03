import { HashRouter, Route, Routes } from 'react-router'
import HomePage from './pages/Home'
import { MockFleetProvider } from './app/MockFleetProvider'
import { AuthProvider } from './app/AuthProvider'
import LiveDriving from './pages/LiveDriving'

export default function App() {
  return (
    <HashRouter>
      <Routes>
        <Route path="/" element={<MockFleetProvider defaultEnabled><HomePage /></MockFleetProvider>} />
        <Route path="/teleop" element={<AuthProvider><LiveDriving /></AuthProvider>} />
      </Routes>
    </HashRouter>
  )
}
