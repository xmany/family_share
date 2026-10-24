// Tiny path router (History API). Path routes, never hash routes: iOS push deep links and the mic
// permission both misbehave with hash navigation. Unknown query parameters (WeChat's ?from=…,
// our own ?src=push) are ignored by matching.

import { createElement, useSyncExternalStore, type AnchorHTMLAttributes, type MouseEvent } from 'react'

export type Route =
  | { name: 'chat' }
  | { name: 'board' }
  | { name: 'item'; id: string }
  | { name: 'weekly' }
  | { name: 'settings' }
  | { name: 'join' }
  | { name: 'link'; token: string }
  | { name: 'not_found' }

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s)
  } catch {
    return s
  }
}

/** Maps a pathname to a route. Pure (used in tests). */
export function matchRoute(pathname: string): Route {
  const p = pathname.replace(/\/{2,}/g, '/').replace(/\/+$/, '') || '/'
  switch (p) {
    case '/':
    case '/index.html':
      return { name: 'chat' }
    case '/board':
      return { name: 'board' }
    case '/weekly':
      return { name: 'weekly' }
    case '/settings':
      return { name: 'settings' }
    case '/join':
      return { name: 'join' }
  }
  let m = /^\/item\/([^/]+)$/.exec(p)
  if (m?.[1]) return { name: 'item', id: safeDecode(m[1]) }
  m = /^\/t\/([^/]+)$/.exec(p)
  if (m?.[1]) return { name: 'link', token: safeDecode(m[1]) }
  return { name: 'not_found' }
}

/** Removes our own `src=push` marker from a search string; keeps everything else untouched. */
export function stripPushMarker(search: string): string {
  if (!search || !search.includes('src=')) return search
  const params = new URLSearchParams(search)
  if (params.get('src') !== 'push') return search
  params.delete('src')
  const s = params.toString()
  return s ? `?${s}` : ''
}

export interface Loc {
  pathname: string
  search: string
  hash: string
  /** Unique per history entry; used for scroll restoration */
  key: string
  /** Position in this app's history stack (0 = the entry the app was opened on) */
  idx: number
  action: 'init' | 'push' | 'replace' | 'pop'
}

interface HistState {
  key: string
  idx: number
}

let current: Loc | null = null
const listeners = new Set<() => void>()

const newKey = () => Math.random().toString(36).slice(2, 10)

function readLocation(action: Loc['action']): Loc {
  const st = (window.history.state ?? null) as Partial<HistState> | null
  return {
    pathname: window.location.pathname,
    search: window.location.search,
    hash: window.location.hash,
    key: st?.key ?? 'init',
    idx: typeof st?.idx === 'number' ? st.idx : 0,
    action,
  }
}

function ensureInit(): Loc {
  if (current) return current
  const st = window.history.state as Partial<HistState> | null
  const search = stripPushMarker(window.location.search)
  const url = window.location.pathname + search + window.location.hash
  if (!st?.key || search !== window.location.search) {
    window.history.replaceState({ key: st?.key ?? newKey(), idx: st?.idx ?? 0 } satisfies HistState, '', url)
  }
  current = readLocation('init')
  window.addEventListener('popstate', () => {
    current = readLocation('pop')
    emit()
  })
  return current
}

function emit() {
  for (const l of listeners) l()
}

export function getLocation(): Loc {
  return ensureInit()
}

/**
 * Navigates within the app. Accepts paths ("/item/i_1") and absolute URLs (from push notifications);
 * other origins get a full navigation.
 */
export function navigate(to: string, opts: { replace?: boolean } = {}): void {
  const cur = ensureInit()
  let url: URL
  try {
    url = new URL(to, window.location.href)
  } catch {
    return
  }
  if (url.origin !== window.location.origin) {
    // only real web pages leave the app; never javascript:, data: … (URLs can come from push payloads)
    if (url.protocol === 'https:' || url.protocol === 'http:') window.location.assign(url.href)
    return
  }
  const target = url.pathname + stripPushMarker(url.search) + url.hash
  const here = window.location.pathname + window.location.search + window.location.hash
  if (target === here && !opts.replace) return
  const idx = opts.replace ? cur.idx : cur.idx + 1
  const state: HistState = { key: newKey(), idx }
  if (opts.replace) window.history.replaceState(state, '', target)
  else window.history.pushState(state, '', target)
  current = readLocation(opts.replace ? 'replace' : 'push')
  emit()
}

/** history.back() when there is an in-app entry to go back to, otherwise navigate to the fallback. */
export function goBack(fallback: string): void {
  const cur = ensureInit()
  if (cur.idx > 0) window.history.back()
  else navigate(fallback, { replace: true })
}

function subscribe(fn: () => void): () => void {
  ensureInit()
  listeners.add(fn)
  return () => listeners.delete(fn)
}

export function useLocation(): Loc {
  return useSyncExternalStore(subscribe, getLocation, getLocation)
}

type LinkProps = AnchorHTMLAttributes<HTMLAnchorElement> & { to: string; replace?: boolean }

/** <a> that navigates in-app on a plain click (modifier clicks still open normally). */
export function Link({ to, replace, onClick, ...rest }: LinkProps) {
  return createElement('a', {
    ...rest,
    href: to,
    onClick: (e: MouseEvent<HTMLAnchorElement>) => {
      onClick?.(e)
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return
      e.preventDefault()
      navigate(to, { replace })
    },
  })
}
