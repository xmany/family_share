import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import { App } from './App'
import { initServiceWorker } from './lib/push'
import { navigate } from './lib/router'
import { scheduleBoardRefresh } from './lib/store'

// Service worker first, so its registration is ready before anyone taps 开启通知.
initServiceWorker({
  onNavigate: url => {
    navigate(url)
    scheduleBoardRefresh(0)
  },
  onBoardChanged: () => scheduleBoardRefresh(),
})

const root = document.getElementById('root')
if (root) {
  createRoot(root).render(
    <StrictMode>
      <App />
    </StrictMode>,
  )
}
