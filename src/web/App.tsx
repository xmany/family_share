// App shell: routing, session bootstrap, live updates, tab bar.

import { useEffect, useLayoutEffect, useRef, type ReactNode } from 'react'
import { pendingForMeCount } from './lib/board'
import { isAppleDevice } from './lib/platform'
import { syncSubscription } from './lib/push'
import { Link, matchRoute, useLocation, type Route } from './lib/router'
import { startLiveUpdates } from './lib/sse'
import { bootstrap, scheduleBoardRefresh, upsertUtterance, useApp } from './lib/store'
import { ScrollContext } from './scroll'
import { IconBoard, IconChat, IconSettings } from './components/Icons'
import { LogoMark } from './components/Logo'
import { ErrorNote, Spinner, Toaster, WeChatBanner } from './components/ui'
import { BoardPage } from './pages/BoardPage'
import { ChatPage } from './pages/ChatPage'
import { ItemPage } from './pages/ItemPage'
import { JoinPage, SignedOut } from './pages/JoinPage'
import { LinkPage } from './pages/LinkPage'
import { SettingsPage } from './pages/SettingsPage'
import { WeeklyPage } from './pages/WeeklyPage'

/**
 * Keeps --app-h equal to the visual viewport height, so on iOS the keyboard shrinks the app
 * (composer stays visible) instead of panning the whole page.
 */
function useViewportHeight() {
  useEffect(() => {
    const vv = window.visualViewport
    if (!vv) return
    let raf = 0
    const update = () => {
      cancelAnimationFrame(raf)
      raf = requestAnimationFrame(() => {
        if (Math.abs(vv.scale - 1) > 0.01) return // pinch-zoomed: leave the layout alone
        document.documentElement.style.setProperty('--app-h', `${Math.round(vv.height)}px`)
        if (isAppleDevice() && (window.scrollY !== 0 || vv.offsetTop !== 0)) window.scrollTo(0, 0)
      })
    }
    update()
    vv.addEventListener('resize', update)
    return () => {
      cancelAnimationFrame(raf)
      vv.removeEventListener('resize', update)
    }
  }, [])
}

export function App() {
  useViewportHeight()
  const loc = useLocation()
  const route = matchRoute(loc.pathname)

  if (route.name === 'link') {
    return (
      <PublicShell>
        <LinkPage key={route.token} token={route.token} />
      </PublicShell>
    )
  }
  if (route.name === 'join') {
    return (
      <PublicShell>
        <JoinPage />
      </PublicShell>
    )
  }
  return <SignedInApp route={route} />
}

function PublicShell({ children }: { children: ReactNode }) {
  return (
    <div className="app-shell">
      <WeChatBanner />
      <main className="app-main">{children}</main>
      <Toaster />
    </div>
  )
}

function SignedInApp({ route }: { route: Route }) {
  const app = useApp()

  useEffect(() => {
    if (app.auth === 'idle') void bootstrap()
  }, [app.auth])

  // live updates while signed in
  useEffect(() => {
    if (app.auth !== 'ready') return
    return startLiveUpdates({
      onEvent(e) {
        if (e.type === 'board_changed') scheduleBoardRefresh()
        else if (e.type === 'utterance') {
          upsertUtterance(e.utterance)
          scheduleBoardRefresh()
        }
      },
      onResync: () => scheduleBoardRefresh(),
    })
  }, [app.auth])

  // every launch: re-register this device's push subscription (iOS never fires pushsubscriptionchange)
  const vapidKey = app.me?.vapidPublicKey ?? null
  useEffect(() => {
    if (app.auth === 'ready' && vapidKey) void syncSubscription(vapidKey)
  }, [app.auth, vapidKey])

  if (app.auth === 'idle' || app.auth === 'loading') return <Splash />
  if (app.auth === 'signed_out') {
    return (
      <PublicShell>
        <SignedOut />
      </PublicShell>
    )
  }
  if (app.auth === 'error' || !app.board) {
    return (
      <PublicShell>
        <ErrorNote message={app.error ?? '加载失败了'} onRetry={() => void bootstrap()} />
      </PublicShell>
    )
  }

  return (
    <Shell route={route} badge={pendingForMeCount(app.board.items, app.board.me.id)}>
      {route.name === 'chat' && <ChatPage />}
      {route.name === 'board' && <BoardPage />}
      {route.name === 'item' && <ItemPage key={route.id} id={route.id} />}
      {route.name === 'weekly' && <WeeklyPage />}
      {route.name === 'settings' && <SettingsPage />}
      {route.name === 'not_found' && <NotFound />}
    </Shell>
  )
}

function Shell({ route, badge, children }: { route: Route; badge: number; children: ReactNode }) {
  const mainRef = useRef<HTMLElement>(null)
  const loc = useLocation()
  const positions = useRef(new Map<string, number>())

  // scroll: new page → top; back/forward → where you were. The chat page handles its own.
  useLayoutEffect(() => {
    const el = mainRef.current
    if (!el || route.name === 'chat') return
    el.scrollTop = loc.action === 'pop' ? (positions.current.get(loc.key) ?? 0) : 0
  }, [loc.key, loc.action, route.name])

  const tab = route.name === 'chat' ? 'chat' : route.name === 'settings' ? 'settings' : route.name === 'not_found' ? null : 'board'

  return (
    <ScrollContext.Provider value={mainRef}>
      <div className="app-shell">
        <WeChatBanner />
        <main
          ref={mainRef}
          className="app-main"
          onScroll={e => positions.current.set(loc.key, e.currentTarget.scrollTop)}
        >
          {children}
        </main>
        <TabBar active={tab} badge={badge} />
        <Toaster />
      </div>
    </ScrollContext.Provider>
  )
}

function TabBar({ active, badge }: { active: 'chat' | 'board' | 'settings' | null; badge: number }) {
  const tabs = [
    { key: 'chat', to: '/', label: '对话', Icon: IconChat },
    { key: 'board', to: '/board', label: '看板', Icon: IconBoard },
    { key: 'settings', to: '/settings', label: '设置', Icon: IconSettings },
  ] as const
  return (
    <nav className="tabbar" aria-label="主导航">
      {tabs.map(({ key, to, label, Icon }) => (
        <Link key={key} to={to} className="tab" aria-current={active === key ? 'page' : undefined}>
          <Icon size={24} />
          <span>{label}</span>
          {key === 'board' && badge > 0 && (
            <span className="tab-badge" aria-label={`${badge} 件等我回复`}>
              {badge > 99 ? '99+' : badge}
            </span>
          )}
        </Link>
      ))}
    </nav>
  )
}

function Splash() {
  return (
    <div className="app-shell items-center justify-center gap-5">
      <LogoMark size={72} />
      <Spinner />
    </div>
  )
}

function NotFound() {
  return (
    <div className="page items-center justify-center gap-4 px-6 py-24 text-center">
      <p className="text-[18px] font-semibold">没有这个页面</p>
      <Link to="/" className="btn btn-primary" replace>
        回到对话
      </Link>
    </div>
  )
}
