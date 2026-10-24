// App-wide state: session, /api/me, /api/board. A tiny external store (useSyncExternalStore).
// The board is the source of truth for the chat and board screens; mutations merge their
// returned items immediately, then SSE / refetches reconcile.

import { useEffect, useState, useSyncExternalStore } from 'react'
import type { BoardResponse, MeResponse } from '../../shared/api'
import type { Item, Member, Utterance } from '../../shared/types'
import { api, isApiError, onUnauthorized } from './api'
import { pendingForMeCount } from './board'

export type AuthState = 'idle' | 'loading' | 'ready' | 'signed_out' | 'error'

export interface AppState {
  auth: AuthState
  error: string | null
  me: MeResponse | null
  board: BoardResponse | null
  /** serverTime - local clock, so relative labels match the server */
  skewMs: number
}

let state: AppState = { auth: 'idle', error: null, me: null, board: null, skewMs: 0 }
const listeners = new Set<() => void>()

function set(patch: Partial<AppState>) {
  state = { ...state, ...patch }
  for (const l of listeners) l()
}

function subscribe(fn: () => void) {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

export function getState(): AppState {
  return state
}

export function useApp(): AppState {
  return useSyncExternalStore(subscribe, getState, getState)
}

/** Current time corrected by the server clock skew. */
export function now(): Date {
  return new Date(Date.now() + state.skewMs)
}

/** Re-renders every `intervalMs` so relative labels (今天/已过期) stay right. */
export function useNow(intervalMs = 60_000): Date {
  const [, setTick] = useState(0)
  useEffect(() => {
    const id = setInterval(() => setTick(t => t + 1), intervalMs)
    return () => clearInterval(id)
  }, [intervalMs])
  return now()
}

onUnauthorized(() => {
  if (state.auth !== 'signed_out') set({ auth: 'signed_out', me: null, board: null })
})

let bootstrapping: Promise<void> | null = null

/** Loads /api/me and /api/board. Safe to call repeatedly. */
export function bootstrap(): Promise<void> {
  if (bootstrapping) return bootstrapping
  if (state.auth !== 'ready') set({ auth: 'loading', error: null })
  bootstrapping = (async () => {
    try {
      const [me, board] = await Promise.all([api.me(), api.board()])
      set({
        auth: 'ready',
        error: null,
        me,
        board,
        skewMs: new Date(board.serverTime).getTime() - Date.now(),
      })
      updateAppBadge()
    } catch (e) {
      if (isApiError(e) && e.status === 401) set({ auth: 'signed_out', me: null, board: null })
      else set({ auth: state.me ? 'ready' : 'error', error: isApiError(e) ? e.message : '加载失败了' })
    } finally {
      bootstrapping = null
    }
  })()
  return bootstrapping
}

export function setSignedOut(): void {
  set({ auth: 'signed_out', me: null, board: null })
  clearAppBadge()
}

let refreshInFlight: Promise<void> | null = null
let refreshAgain = false

export function refreshBoard(): Promise<void> {
  if (state.auth !== 'ready') return Promise.resolve()
  if (refreshInFlight) {
    refreshAgain = true
    return refreshInFlight
  }
  refreshInFlight = (async () => {
    try {
      const board = await api.board()
      set({ board, skewMs: new Date(board.serverTime).getTime() - Date.now() })
      updateAppBadge()
    } catch {
      // keep the last board; a 401 already signed us out
    } finally {
      refreshInFlight = null
      if (refreshAgain) {
        refreshAgain = false
        void refreshBoard()
      }
    }
  })()
  return refreshInFlight
}

let refreshTimer: ReturnType<typeof setTimeout> | null = null
/** Debounced board refetch (SSE bursts, SW messages, visibility changes). */
export function scheduleBoardRefresh(delayMs = 300): void {
  if (refreshTimer) clearTimeout(refreshTimer)
  refreshTimer = setTimeout(() => {
    refreshTimer = null
    void refreshBoard()
  }, delayMs)
}

/** Merges item snapshots returned by a mutation into the board. */
export function mergeItems(items: Item[]): void {
  const board = state.board
  if (!board || items.length === 0) return
  const byId = new Map(items.map(i => [i.id, i]))
  const merged = board.items.map(i => byId.get(i.id) ?? i)
  for (const it of items) if (!board.items.some(i => i.id === it.id)) merged.unshift(it)
  set({ board: { ...board, items: merged } })
  updateAppBadge()
}

export function upsertUtterance(u: Utterance): void {
  const board = state.board
  if (!board) return
  const idx = board.utterances.findIndex(x => x.id === u.id)
  const utterances = idx >= 0 ? board.utterances.map(x => (x.id === u.id ? u : x)) : [...board.utterances, u]
  set({ board: { ...board, utterances } })
}

export function updateMe(member: Member): void {
  const patch: Partial<AppState> = {}
  if (state.me) patch.me = { ...state.me, me: member }
  if (state.board) {
    patch.board = {
      ...state.board,
      me: member,
      members: state.board.members.map(m => (m.id === member.id ? member : m)),
    }
  }
  set(patch)
}

/** Signed-in member (board copy is fresher). */
export function useMe(): Member | null {
  const s = useApp()
  return s.board?.me ?? s.me?.me ?? null
}

export function timezoneOf(s: AppState): string {
  return s.board?.family.timezone ?? s.me?.family.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone
}

// ---- app icon badge = requests waiting for my answer (iOS 16.4+ Home Screen apps, desktop PWAs)

type BadgeNavigator = Navigator & {
  setAppBadge?: (n?: number) => Promise<void>
  clearAppBadge?: () => Promise<void>
}

function updateAppBadge() {
  const b = state.board
  if (!b) return
  const n = pendingForMeCount(b.items, b.me.id)
  const nav = navigator as BadgeNavigator
  try {
    if (n > 0) nav.setAppBadge?.(n).catch(() => {})
    else nav.clearAppBadge?.().catch(() => {})
  } catch {
    // unsupported
  }
}

function clearAppBadge() {
  try {
    ;(navigator as BadgeNavigator).clearAppBadge?.().catch(() => {})
  } catch {
    // unsupported
  }
}
