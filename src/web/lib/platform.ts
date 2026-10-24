// Device / browser detection. The *FromUA helpers are pure (unit-tested); the wrappers read the
// current browser and are only called at runtime (never at import time, so tests run in node).

export function isIOSFromUA(ua: string, platform = '', maxTouchPoints = 0): boolean {
  if (/iPhone|iPad|iPod/i.test(ua)) return true
  if (/Android/i.test(ua)) return false
  // iPadOS 13+ reports a desktop Mac user agent; touch support gives it away.
  return (platform === 'MacIntel' || /Macintosh/.test(ua)) && maxTouchPoints > 1
}

export function isAndroidFromUA(ua: string): boolean {
  return /Android/i.test(ua)
}

/** WeChat's in-app browser (no install, no push). */
export function isWeChatFromUA(ua: string): boolean {
  return /MicroMessenger/i.test(ua)
}

/** Safari on macOS (not Chrome/Edge/Firefox on a Mac, which use their own engines). */
export function isMacSafariFromUA(ua: string): boolean {
  return /Macintosh/.test(ua) && /Safari\//.test(ua) && !/Chrome|Chromium|CriOS|Edg\/|Firefox|FxiOS|OPR\//.test(ua)
}

/** Apple WebKit devices: every browser on iOS/iPadOS, and Safari on macOS. */
export function isAppleFromUA(ua: string, platform = '', maxTouchPoints = 0): boolean {
  return isIOSFromUA(ua, platform, maxTouchPoints) || isMacSafariFromUA(ua)
}

// ---- runtime wrappers

function nav(): Navigator | null {
  return typeof navigator === 'undefined' ? null : navigator
}

export function isIOS(): boolean {
  const n = nav()
  return !!n && isIOSFromUA(n.userAgent, n.platform, n.maxTouchPoints)
}

export function isAndroid(): boolean {
  const n = nav()
  return !!n && isAndroidFromUA(n.userAgent)
}

export function isWeChat(): boolean {
  const n = nav()
  return !!n && isWeChatFromUA(n.userAgent)
}

export function isAppleDevice(): boolean {
  const n = nav()
  return !!n && isAppleFromUA(n.userAgent, n.platform, n.maxTouchPoints)
}

/** Running as an installed app (Home Screen web app on iOS, WebAPK / installed PWA elsewhere). */
export function isStandalone(): boolean {
  if (typeof window === 'undefined') return false
  const iosStandalone = (navigator as Navigator & { standalone?: boolean }).standalone === true
  const mm = (q: string) => typeof window.matchMedia === 'function' && window.matchMedia(q).matches
  return iosStandalone || mm('(display-mode: standalone)') || mm('(display-mode: fullscreen)') || mm('(display-mode: minimal-ui)')
}

/** VAPID public key (URL-safe base64) → bytes for pushManager.subscribe(). */
export function urlBase64ToUint8Array(base64: string): Uint8Array<ArrayBuffer> {
  const padded = (base64 + '='.repeat((4 - (base64.length % 4)) % 4)).replace(/-/g, '+').replace(/_/g, '/')
  const raw = atob(padded)
  const out = new Uint8Array(new ArrayBuffer(raw.length))
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i)
  return out
}

/** Byte equality of two key buffers. */
export function sameBytes(a: ArrayBuffer | ArrayBufferView | null | undefined, b: Uint8Array): boolean {
  if (!a) return false
  const av = a instanceof ArrayBuffer ? new Uint8Array(a) : new Uint8Array(a.buffer, a.byteOffset, a.byteLength)
  if (av.length !== b.length) return false
  for (let i = 0; i < av.length; i++) if (av[i] !== b[i]) return false
  return true
}
