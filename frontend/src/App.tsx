import { HashRouter, Route, Routes } from 'react-router'
import HomePage from './pages/Home'
import { MockFleetProvider } from './app/MockFleetProvider'

export default function App() {
  return (
    <HashRouter>
      <Routes>
        <Route path="/" element={<MockFleetProvider defaultEnabled><HomePage /></MockFleetProvider>} />
      </Routes>
    </HashRouter>
  )
}
