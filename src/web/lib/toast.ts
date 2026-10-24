// Transient messages ("链接已复制", errors). One at a time.

import { useSyncExternalStore } from 'react'

export interface Toast {
  id: number
  text: string
  tone: 'neutral' | 'danger' | 'ok'
}

let current: Toast | null = null
let seq = 0
let timer: ReturnType<typeof setTimeout> | null = null
const listeners = new Set<() => void>()

function emit() {
  for (const l of listeners) l()
}

export function toast(text: string, tone: Toast['tone'] = 'neutral', ms = 2600): void {
  current = { id: ++seq, text, tone }
  emit()
  if (timer) clearTimeout(timer)
  timer = setTimeout(() => {
    current = null
    emit()
  }, ms)
}

export function dismissToast(): void {
  current = null
  if (timer) clearTimeout(timer)
  emit()
}

export function useToast(): Toast | null {
  return useSyncExternalStore(
    fn => {
      listeners.add(fn)
      return () => listeners.delete(fn)
    },
    () => current,
    () => current,
  )
}

/** Copies text; falls back to a hidden textarea for older WebViews (WeChat). */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch {
    // fall through
  }
  try {
    const ta = document.createElement('textarea')
    ta.value = text
    ta.setAttribute('readonly', '')
    ta.style.position = 'fixed'
    ta.style.opacity = '0'
    document.body.appendChild(ta)
    ta.select()
    ta.setSelectionRange(0, text.length)
    const ok = document.execCommand('copy')
    document.body.removeChild(ta)
    return ok
  } catch {
    return false
  }
}

/** navigator.share when available (WeChat / WhatsApp from the share sheet), else copy the link. */
export async function shareOrCopy(data: { title: string; text: string; url: string }): Promise<void> {
  if (typeof navigator.share === 'function') {
    try {
      await navigator.share(data)
      return
    } catch (e) {
      if ((e as { name?: string } | null)?.name === 'AbortError') return
    }
  }
  const ok = await copyText(data.url)
  toast(ok ? '链接已复制，可以粘贴到微信发给家人' : '复制失败，请长按链接手动复制', ok ? 'ok' : 'danger')
}
