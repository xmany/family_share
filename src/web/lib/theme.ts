// Light / dark / follow the phone (设置 → 外观), as hulicalendar does it (its lib/prefs.ts): a per-device choice kept in
// localStorage and nowhere else, written only when it differs from the default, so a phone that never chose follows
// its own setting. index.html applies it before the first paint (the same key and rule, inline); this module keeps it
// current: the phone switching between light and dark, another tab changing it, and the picker in Settings.

import { useSyncExternalStore } from 'react'

export type ThemePref = 'system' | 'light' | 'dark'
export type Theme = 'light' | 'dark'

/** Read by the inline script in index.html too: keep the two in step. */
export const THEME_KEY = 'fs_theme'

/** What is stored, as a preference (anything else, or nothing, is "follow the phone"). */
export function parseThemePref(stored: string | null): ThemePref {
  return stored === 'light' || stored === 'dark' ? stored : 'system'
}

export function resolveTheme(pref: ThemePref, systemDark: boolean): Theme {
  return pref === 'system' ? (systemDark ? 'dark' : 'light') : pref
}

function read(): string | null {
  try {
    return localStorage.getItem(THEME_KEY)
  } catch {
    return null
  }
}

function write(pref: ThemePref) {
  try {
    if (pref === 'system') localStorage.removeItem(THEME_KEY)
    else localStorage.setItem(THEME_KEY, pref)
  } catch {
    // storage unavailable (private mode): the choice lasts while this page is open
  }
}

let pref: ThemePref = parseThemePref(read())
const listeners = new Set<() => void>()
const darkQuery = () => window.matchMedia('(prefers-color-scheme: dark)')

/** Sets <html data-theme> (index.css keys every colour off it) and the browser chrome colour to match. */
export function applyTheme() {
  const theme = resolveTheme(pref, darkQuery().matches)
  const html = document.documentElement
  html.dataset.theme = theme
  const bg = getComputedStyle(html).getPropertyValue('--color-bg').trim()
  if (bg) document.querySelectorAll('meta[name="theme-color"]').forEach(m => m.setAttribute('content', bg))
}

function emit() {
  applyTheme()
  listeners.forEach(fn => fn())
}

export function setThemePref(next: ThemePref) {
  pref = next
  write(next)
  emit()
}

let started = false
/** Once, at startup: apply the choice and follow the phone and other tabs from then on. */
export function initTheme() {
  if (started) return
  started = true
  applyTheme()
  darkQuery().addEventListener('change', () => {
    if (pref === 'system') emit()
  })
  window.addEventListener('storage', e => {
    if (e.key !== THEME_KEY && e.key !== null) return
    pref = parseThemePref(read())
    emit()
  })
}

export function useThemePref(): ThemePref {
  return useSyncExternalStore(
    cb => {
      listeners.add(cb)
      return () => listeners.delete(cb)
    },
    () => pref,
  )
}
