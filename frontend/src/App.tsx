import { HashRouter, Route, Routes } from 'react-router'
import { AuthProvider } from './app/AuthProvider'
import HomePage from './pages/Home'

export default function App() {
  return (
    <AuthProvider>
      <HashRouter>
        <Routes>
          <Route path="/" element={<HomePage />} />
        </Routes>
      </HashRouter>
    </AuthProvider>
  )
}
