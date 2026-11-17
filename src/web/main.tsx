import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
// hulicalendar's type: Familjen Grotesk for Latin and figures, Geist Mono for times and codes (self-hosted; Chinese
// falls through to the system's PingFang SC / Noto Sans SC in index.css)
import '@fontsource-variable/familjen-grotesk'
import '@fontsource-variable/geist-mono'
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
