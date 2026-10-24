# Research brief: pwa (2026-10-21)

## Recommendation

For v0, use only standard VAPID Web Push, sent from one HTTPS origin that never changes. On the server, use `web-push` 3.6.7 (Node 20+). Send every message in the Declarative Web Push JSON shape (`web_push: 8030`). iOS 18.4+ shows it natively with no dependency on the service worker. Chrome on Android hands it to your service worker, which parses the same JSON and adds two action buttons, 可以 / 不行, that POST back with a signed token. iPhones never show action buttons, so a tap must deep-link to a task card with big Accept / Can't buttons. Build with vite-plugin-pwa 2.0.0 using `strategies: 'injectManifest'`. Test on real phones through Tailscale Funnel (`tailscale funnel --bg 3000`) on a hostname you will keep: push subscriptions, Home Screen installs, storage and permissions are all tied to the origin. Defer ntfy to v1 as an optional extra channel, for an Android phone without Google Play services or an iPhone user who wants native action buttons.

# PWA platform realities for family_share (as of 2026-10-21)

## TL;DR decisions
| Concern | v0 decision |
|---|---|
| Push transport | Standard Web Push (RFC 8030/8291/8292, VAPID). No Apple Developer account, no FCM project, no API keys. Free. |
| Payload format | **Declarative Web Push JSON** (`{"web_push":8030,...}`) for all devices. iOS 18.4+ renders it without JS. Chrome/Firefox/older iOS deliver it to the service worker `push` handler, which renders it itself. |
| Accept / Can't buttons | **Android Chrome: yes** (2 actions, handled silently in the service worker via `fetch`). **iOS: no** action buttons. Tap opens a deep link to the task card, which has big in-app buttons. |
| Server lib | `web-push` 3.6.7 (last npm release Jan 2024; repo still active in Sep 2026; not archived). Alternative: `@pushforge/builder` 2.0.5 (zero-dep, Web Crypto, Apr 2026). |
| Build | `vite-plugin-pwa` **2.0.0** (2026-10-03, Node >= 20.19, Vite 3-8, workbox 7.4.1), `strategies: 'injectManifest'`. |
| Mic | Works in both installed PWAs. **iOS asks again on every app launch** (no persistent grant for Home Screen apps; WebKit bug 327237 filed 2026-10-12, still NEW). Android Chrome remembers the grant per origin. |
| Phone testing | Tailscale Funnel: stable `https://<machine>.<tailnet>.ts.net`. Avoid Cloudflare quick tunnels for push work: random hostname every run, and no SSE. |
| Fallback channel | ntfy is v1 and optional. Model notification channels as a server-side interface now. |

---

## 1. iOS / iPadOS web push for Home Screen web apps

**Minimums and rules (Apple docs and WebKit)**
- **Classic web push: iOS/iPadOS 16.4+**, only for **Home Screen web apps**. A Safari tab gets no `PushManager`. No Apple Developer Program membership is needed.
- **Declarative Web Push: iOS/iPadOS 18.4+** (macOS Safari 18.5). Chrome does not support it (crbug 382298314), and neither does Firefox (bug 1935325) per MDN BCD.
- **iOS 26 change:** every site added to the Home Screen opens as a web app by default. The "Open as Web App" toggle is on by default, and WebKit says there are "zero requirements for installability". You should still ship a manifest, because it supplies the icons, name and `id`.
- **User-gesture rule:** permission must come from a tap. Apple: "When the user completes the gesture, call the push subscription method immediately from the gesture's event handler code." Get the service worker registration **before** the tap, and make `pushManager.subscribe()` (which shows the permission prompt) the first `await` inside the click handler.
- **No invisible pushes:** "Present push notifications to the user immediately after your service worker receives them. If you don't, Safari revokes the push notification permission for your site." Declarative messages remove this risk, because the browser shows them itself.
- **Server-side requirements (Apple):**
  - Allow outbound `https://*.push.apple.com`. TLS with SNI is required; HTTP/1.1 and HTTP/2 both work.
  - Headers: `TTL` (stored for up to 30 days), `Urgency` (`very-low|low|normal|high`), `Topic` (up to 32 URL-safe base64 characters; coalesces messages that are still pending), `Authorization` (VAPID), `Content-Encoding`.
  - Payload limit **4 KB** (`PayloadTooLarge`/413). Chinese text costs 3 bytes per character in UTF-8, so keep the JSON under about 3 KB and fetch details when the notification is tapped.
  - VAPID JWT `exp` must be at most 24 h ahead. `sub` must be `mailto:` or `https:` and must not be localhost, or Apple returns `BadJwtToken`. Apple also says "Don't refresh your JWT more frequently than once per hour".
  - Status codes: 201 OK, 400, 403 (auth/VAPID), 404, **410 (token expired)**, 413, 429, 500, 503. The JSON `reason` field gives the cause (`VapidPkHashMismatch`, `BadJwtToken`, `BadTtl`, ...).

**Declarative Web Push format** (W3C Push API draft and WebKit):
```json
{
  "web_push": 8030,
  "notification": {
    "title": "妈妈：明天下午能去接孩子吗？",
    "body": "周三 15:30 · 学校门口 · 点开回复",
    "navigate": "https://family.example.com/t/9f2c1a?src=push",
    "lang": "zh-CN",
    "tag": "task-9f2c1a",
    "data": { "taskId": "9f2c1a", "kind": "nudge", "tok": "<signed>",
              "actions": [{"action":"accept","title":"✅ 可以"},{"action":"decline","title":"🙅 不行"}] }
  },
  "app_badge": "3"
}
```
- Required: `web_push: 8030`, `notification.title`, `notification.navigate` (an absolute URL). Optional members follow `NotificationOptions` (`body`, `lang`, `dir`, `tag`, `icon`, `badge`, `data`, `silent`, `requireInteraction`, `actions[{action,title,navigate}]`, and so on). `mutable: true` (top level) makes iOS fire a `push` event to the service worker so it can modify the notification. Leave it false: iOS then shows the notification with no JavaScript, and a tap opens `navigate`.
- `app_badge` is a WebKit extension; the spec does not define it. WebKit's example gives it as a string.
- The spec detects declarative messages by parsing the JSON, not by Content-Type, and WebKit's post names no required header. `web-push` forces `Content-Type: application/octet-stream` anyway, so don't fight it.
- Keep the button list in `data.actions`, not `notification.actions`. A spec-compliant `notification.actions` entry needs a `navigate` URL for each action, and iOS would not render the buttons anyway.
- A root-scope service worker and `window.pushManager` share the same subscription.

**Notification feature matrix** (MDN BCD, Oct 2026)
| Feature | iOS Home Screen app | Android Chrome |
|---|---|---|
| `actions` buttons | **No** (`maxActions` unsupported; forums show only the default action) | **Yes**, `Notification.maxActions` = 2. Icons are not shown on Android 7+, so put emoji in the titles. |
| `tag` replace/coalesce | **No** (Safari: "can be set, but has no effect") | Yes, plus `renotify` |
| `image`, `badge` (small icon), `requireInteraction`, `silent`, `vibrate` | No | Mostly yes (`vibrate` has no effect on Android O+) |
| Badging (`navigator.setAppBadge`) | **Yes, 16.4+** (`0` clears). User controls it under Settings > Notifications > app > Badges. | **No** in Chrome Android. The launcher dot comes from active notifications. |
| `notificationclick` in the service worker | BCD marks it unsupported, but bug reports show it firing (see risks). Rely on declarative `navigate`. | Yes |
| `pushsubscriptionchange` | **No** (WebKit does not fire it, per Apple's Ben Nham) | Chrome 138+ |

**Focus modes and Summary:** web app notifications follow Focus just like native apps, and Focus settings sync across devices through the manifest `id`. To let nudges through, each parent adds 家庭助手 to Focus > Allowed Apps and sets Settings > Notifications > 家庭助手 to Immediate Delivery rather than Scheduled Summary. I found no way for web push to set the Time Sensitive interruption level.

**2025-2026 changes:**
- Safari 18.4 (2025) added Declarative Web Push.
- iOS 26 made "Open as Web App" the default.
- Safari 26.0 dropped `theme-color` tinting in Safari tabs; developers report the color now comes from the page background.
- In the Safari 26.3, 26.4, 26.5, 26.6 and 27.0 feature posts (Sep 2026, iOS 27) I found no web push or Home Screen changes, only service worker fixes and the SW static routing API. I did not check 26.1 or 26.2.
- EU DMA: Apple removed Home Screen web apps in the EU in the iOS 17.4 beta (Feb 2024), then restored them in March 2024, still running on WebKit. I found no change since. It only matters if the family lives in the EU.

**Other iOS facts that matter**
- A Home Screen app has **separate storage from Safari**. Cookies are copied once at install; nothing else is copied. Log in **inside the installed app**. Use a server-set HttpOnly cookie session rather than a token in localStorage: ITP's 7-day cap applies to script-written storage, and web apps keep their own day counter.
- Deleting the Home Screen icon destroys the subscription. The server will then get 410 or 404.
- Onboarding: links shared in WeChat open in WeChat's in-app browser. Tell family members to use "…" > 在 Safari 中打开 / 在浏览器打开 and then Share > 添加到主屏幕.

## 2. Android

- **Chrome web push goes through FCM** (endpoint `https://fcm.googleapis.com/fcm/send/...`), which depends on Google Play services. With VAPID you need **no FCM API key or Firebase project**; FCM speaks standard Web Push.
- Installing as a WebAPK (a real app in the launcher, with its own entry in notification settings) needs Chrome on a GMS device or Samsung Internet on Samsung.
- Phones sold outside mainland China (Xiaomi/Redmi HyperOS Global, OPPO/OnePlus, vivo, Samsung, Pixel) ship with GMS, so web push works. OEM battery managers can still delay pushes. During onboarding:
  - Set Chrome's battery mode to Unrestricted.
  - Allow autostart where the ROM has it.
  - Send nudges with `Urgency: high`, which maps to high-priority FCM messages that can wake the phone from Doze.
- **Huawei without GMS / mainland-ROM phones:** Chrome web push will not be delivered. This is strongly implied, but I found no current Google doc saying so. HarmonyOS NEXT (5.x) cannot run APKs at all, so neither Chrome nor the ntfy APK can be installed there. Treat it as unsupported.
- **ntfy as a fallback** (server v2.32.0 2026-10-18, Android 1.25.2 2026-07, iOS app 1.7.0 2026-05; all active):
  - Android: "instant delivery" uses a **foreground service** with a persistent notification and a WebSocket. It needs no FCM for self-hosted servers ("It won't use Firebase for any self-hosted servers, and not at all in the F-Droid flavor"). The ping interval is 3 min (v1.25.2).
  - iOS: a self-hosted server must set `upstream-base-url: "https://ntfy.sh"`. Your server then sends ntfy.sh only a poll request: `X-Poll-ID` plus the SHA-256 of the topic URL, with the text "New message". The app then fetches the real message from your server. Without it, delivery "can take hours".
  - Per the docs, the **action buttons (`view`, `http`) work on Android, iOS and web**. That gives the iPhone native 可以/不行 buttons, which web push cannot. I did not verify whether the iOS `http` action runs without opening the app.
  - Publish (JSON is safest for Chinese text; header publishing needs RFC 2047 encoding when a library mangles UTF-8):
```bash
curl -u :tk_XXXX https://ntfy.family.example.com/ -H 'Content-Type: application/json' -d '{
  "topic": "fam-dad-7f3k",
  "title": "妈妈：明天下午能去接孩子吗？",
  "message": "周三 15:30 · 学校门口",
  "priority": 4, "tags": ["calendar"],
  "click": "https://family.example.com/t/9f2c1a",
  "actions": [
    {"action":"http","label":"✅ 可以","url":"https://family.example.com/api/notify/respond","method":"POST",
     "headers":{"Content-Type":"application/json"},"body":"{\"tok\":\"<signed>\",\"response\":\"accept\"}","clear":true},
    {"action":"http","label":"🙅 不行","url":"https://family.example.com/api/notify/respond","method":"POST",
     "headers":{"Content-Type":"application/json"},"body":"{\"tok\":\"<signed>\",\"response\":\"decline\"}","clear":true}
  ]}'
```
  - Header form: `POST https://ntfy.sh/<topic>` with headers:
    - `Title` (`X-Title`/`t`)
    - `Priority` (1-5, or min/low/default/high/urgent)
    - `Tags`
    - `Click`
    - `Actions` (`http, ✅ 可以, https://…, method=POST, body=…, clear=true; …`), at most **3** actions
    - `Icon`, `Attach`, `Markdown: yes`
    - `In`/`At`/`Delay` (10 s to 3 days)
    - `Cache: no`, `Firebase: no`
  - Auth: `Authorization: Bearer tk_…`, Basic, or `?auth=`.
  - Self-host: `docker run -v /etc/ntfy:/etc/ntfy -p 80:80 -it binwiederhier/ntfy serve`.
    - server.yml keys: `base-url`, `cache-file`, `auth-file`, `auth-default-access: deny-all`, `behind-proxy: true`, `upstream-base-url`.
    - Users and tokens: `ntfy user add --role=admin x`, `ntfy access <user> <topic> rw`, `ntfy token add --expires=30d <user>`.
  - Limits: messages over 4,096 bytes become attachments. The public ntfy.sh free tier allows 250 messages/day. Paid tiers: Supporter $5/mo (2,500/day), Pro $10 (20,000), Business $20 (50,000).
  - **Is it a sensible fallback?** Yes, as an **opt-in second channel**: for a GMS-less Android phone, or an iPhone user who wants buttons. It costs an extra app, a topic per person, a persistent notification on Android, and the ntfy.sh relay for iOS. Not v0.

## 3. Libraries and manifest

**web-push** (`npm i web-push`, types `@types/web-push` 3.6.4)
- Version 3.6.7, CJS on npm. Master is ESM and unreleased. Dependabot and docs commits through Sep 2026; 48 open issues.
- Keys: `npx web-push generate-vapid-keys --json`. Generate once and keep forever: rotating the keys invalidates every subscription (`VapidPkHashMismatch`).
- API: `setVapidDetails(subject, pub, priv)` and `sendNotification(sub, payload, { TTL, urgency, topic, headers, contentEncoding:'aes128gcm' (default), timeout, proxy })`.
- **Default TTL is 4 weeks, so always set it.** `topic` must be URL-safe base64 and at most 32 characters, or the library throws.
- Errors are a `WebPushError` with `{statusCode, headers, body, endpoint}`.
- web-push signs a fresh JWT on every send, against Apple's once-per-hour guidance. At family volume this should not matter (unverified). PushForge and similar libraries can cache the headers.

**vite-plugin-pwa 2.0.0**
- `generateSW` writes a Workbox service worker for you. Custom push code then needs `workbox.importScripts`.
- **Use `injectManifest`** for the push and notificationclick handlers.
- Icons: `npx pwa-assets-generator --preset minimal-2023 public/logo.svg` (`@vite-pwa/assets-generator` 2.0.0, ESM-only, Node >= 20.19). It generates 64/192/512 PNGs, a maskable 512, an apple 180 and favicon.ico 48. The plugin also has a `pwaAssets` option.

```ts
// vite.config.ts
import { defineConfig } from 'vite'
import { VitePWA } from 'vite-plugin-pwa'
export default defineConfig({
  server:  { host: '127.0.0.1', port: 3000, allowedHosts: ['.ts.net'], hmr: { clientPort: 443 } },
  preview: { host: '127.0.0.1', port: 3000, allowedHosts: ['.ts.net'] },
  plugins: [VitePWA({
    strategies: 'injectManifest', srcDir: 'src', filename: 'sw.ts',
    registerType: 'autoUpdate', injectRegister: 'auto',
    injectManifest: { rollupFormat: 'iife' },          // classic SW output, safest on Safari
    devOptions: { enabled: true, type: 'module' },     // test push on `vite build && vite preview`, not dev
    manifest: {
      id: '/', name: '家庭助手 Family Share', short_name: '家庭助手', lang: 'zh-CN',
      start_url: '/', scope: '/', display: 'standalone',
      background_color: '#ffffff', theme_color: '#ffffff',
      icons: [
        { src: 'pwa-64x64.png', sizes: '64x64', type: 'image/png' },
        { src: 'pwa-192x192.png', sizes: '192x192', type: 'image/png' },
        { src: 'pwa-512x512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
        { src: 'maskable-icon-512x512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
      ],
    },
  })],
})
```
Add `"lib": ["ESNext","DOM","WebWorker"]` to tsconfig.

Vite's DNS-rebinding guard blocks hosts that are not allowlisted, which is why the `allowedHosts` entries are there.

**Installability**
- Chrome (web.dev): `name` or `short_name`; icons at 192 and 512; `start_url`; `display` set to standalone, fullscreen, minimal-ui or window-controls-overlay; `prefer_related_applications` absent or false; HTTPS; the user has tapped at least once and spent 30 s on the page.
- iOS: nothing is required (iOS 26), but it uses manifest icons, name and `id`.

`index.html` head:
```html
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#ffffff">
<link rel="icon" href="/favicon.ico" sizes="48x48">
<link rel="apple-touch-icon" href="/apple-touch-icon-180x180.png"><!-- opaque, no transparency -->
<meta name="apple-mobile-web-app-title" content="家庭助手">
<meta name="apple-mobile-web-app-status-bar-style" content="default"><!-- or black-translucent + safe-area insets -->
<meta name="mobile-web-app-capable" content="yes">
```
- Splash screens (`apple-touch-startup-image`, one per device size) are optional; the assets generator can produce them.
- iOS 26 reportedly ignores `theme-color` and sometimes the status-bar meta. Give `html, body` a background color and test on a device.

## 4. Microphone (hold-to-talk)
- **iOS standalone:** `getUserMedia` works. It was broken in standalone mode before 13.4, and the hash-navigation permission reset was fixed around 14.5.
  - The grant **lasts only for the current launch**. The prompt returns on every cold start, and Home Screen apps have no "Always allow" (bug 327237, 2026-10-12, NEW).
  - Avoid full page reloads and hash-only navigations; use a History-API router.
  - In Safari tabs, a WebKit engineer says "If capture is ongoing, prompt should not happen again until 24 hours".
- **Android installed PWA:** works. The permission is stored per origin in Chrome's site settings, which the WebAPK shares. I could not confirm whether Chrome Android has a one-time "Allow this time" option.
- Implementation:
  - Get the stream on the **first press of each session** and keep it while the app is visible, so later presses start instantly. Stop the tracks on `visibilitychange` to hidden; the mic indicator stays on while the stream is live.
  - Pick the MIME type at runtime and send the server the recorder's actual `mimeType` (iOS usually `audio/mp4` AAC; Chrome `audio/webm;codecs=opus`).
  - On the button, set CSS `touch-action:none; -webkit-user-select:none; -webkit-touch-callout:none` so iOS long-press doesn't open the callout.
```ts
let stream: MediaStream | null = null, rec: MediaRecorder | null = null, chunks: Blob[] = []
const mime = ['audio/mp4','audio/webm;codecs=opus','audio/webm'].find(t => MediaRecorder.isTypeSupported(t))
async function mic() { if (stream?.getAudioTracks().some(t => t.readyState === 'live')) return stream
  return (stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, channelCount: 1 } })) }
document.addEventListener('visibilitychange', () => { if (document.hidden) { stream?.getTracks().forEach(t => t.stop()); stream = null } })
btn.addEventListener('pointerdown', async e => { btn.setPointerCapture(e.pointerId); chunks = []
  rec = new MediaRecorder(await mic(), mime ? { mimeType: mime } : undefined)
  rec.ondataavailable = ev => ev.data.size && chunks.push(ev.data); rec.onstop = () => upload(new Blob(chunks, { type: rec!.mimeType })); rec.start(250) })
btn.addEventListener('pointerup', () => rec?.state === 'recording' && rec.stop())
btn.addEventListener('pointercancel', () => rec?.state === 'recording' && rec.stop())
```

## 5. HTTPS on real phones from the Mac
**Tailscale Funnel (recommended)**
1. Install Tailscale for macOS. The App Store and Standalone variants can funnel ports; serving files needs the open-source variant. Enable the CLI.
2. In the admin console, enable MagicDNS and HTTPS Certificates. The first `tailscale funnel` run prints a link that adds the `funnel` nodeAttr to the policy file.
3. Run `vite build && vite preview` (or your Node server) on 127.0.0.1:3000.
4. Run `tailscale funnel 3000` in the foreground, or `tailscale funnel --bg 3000` to persist across reboots. The URL is `https://<machine>.<tailnet>.ts.net/`.
5. Manage it with `tailscale funnel status [--json]`, `tailscale funnel reset`, or `tailscale funnel --https=443 off`.

Limits:
- Public ports 443, 8443 and 10000 only. TLS only. Proxies only to `http://127.0.0.1`.
- "non-configurable bandwidth limits" (numbers not published).
- Public DNS can take up to 10 min.
- Let's Encrypt rate limits can lock certificates for about 34 h if you re-request too often.
- Available on all plans.

**Cloudflare quick tunnel:** `cloudflared tunnel --url http://localhost:3000` gives a `*.trycloudflare.com` hostname that **changes every run**. It allows 200 in-flight requests (429 above that), has **no SSE support** and no uptime guarantee, and is meant for testing only. A named tunnel on your own domain keeps the hostname stable: `cloudflared tunnel login`, `tunnel create family`, `tunnel route dns family app.example.com`, `tunnel run family`.

**Origin binding:** the push subscription, the Home Screen install, storage, cookies and mic/notification permissions all belong to the scheme+host+port. Moving from `mac.tailnet.ts.net` to `family.example.com` means reinstalling, logging in again and re-subscribing on every phone. Renaming the tailnet also changes the origin. Pick the long-term hostname before onboarding grandparents.

## 6. Code: subscription, service worker, server send
**Client (`src/push.ts`)**
```ts
const KEY = import.meta.env.VITE_VAPID_PUBLIC_KEY as string
const b64 = (s: string) => Uint8Array.from(atob((s + '='.repeat((4 - s.length % 4) % 4)).replace(/-/g,'+').replace(/_/g,'/')), c => c.charCodeAt(0))
let reg: ServiceWorkerRegistration | undefined
navigator.serviceWorker?.ready.then(r => { reg = r; syncSubscription() })
export const env = () => ({
  standalone: matchMedia('(display-mode: standalone)').matches || (navigator as any).standalone === true,
  supported: 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window,
  ios: /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1),
}) // ios && !standalone => show "添加到主屏幕" guide instead of the enable button
export async function enablePushFromTap() {            // call directly from onClick
  if (!reg) throw new Error('sw not ready')
  const sub = (await reg.pushManager.getSubscription()) ??
    await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64(KEY) }) // shows prompt
  await save(sub)
}
async function syncSubscription() {                    // every launch: iOS never fires pushsubscriptionchange
  if (Notification.permission !== 'granted' || !reg) return
  const sub = await reg.pushManager.getSubscription()
  sub ? save(sub) : showReEnableBanner()               // re-subscribe needs a tap
}
const save = (sub: PushSubscription) => fetch('/api/push/subscriptions', { method: 'POST', credentials: 'include',
  headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sub: sub.toJSON(), ua: navigator.userAgent }) })
navigator.serviceWorker?.addEventListener('message', e => { if (e.data?.type === 'navigate') router.push(new URL(e.data.url).pathname + new URL(e.data.url).search)
  if (e.data?.type === 'task-updated') refetchTasks() })
```
Store subscriptions in a table with these columns: `push_subscriptions(id, member_id, endpoint UNIQUE, p256dh, auth, ua, created_at, last_seen_at, last_success_at, fail_count)`. Upsert on `endpoint`.

**Service worker (`src/sw.ts`)**
```ts
/// <reference lib="webworker" />
import { precacheAndRoute, cleanupOutdatedCaches } from 'workbox-precaching'
import { clientsClaim } from 'workbox-core'
declare let self: ServiceWorkerGlobalScope
cleanupOutdatedCaches(); precacheAndRoute(self.__WB_MANIFEST); self.skipWaiting(); clientsClaim()

// iOS 18.4+ shows declarative messages itself (mutable=false) and never calls this.
// Chrome/Android, Firefox and iOS 16.4-18.3 land here, so ALWAYS show a notification.
self.addEventListener('push', (event) => {
  let p: any
  try { p = event.data?.json() } catch { p = null }
  const n = p?.notification ?? { title: '家庭助手', body: event.data?.text() ?? '', navigate: '/' }
  const data = { ...(n.data ?? {}), navigate: n.navigate }
  const max = (self as any).Notification?.maxActions ?? 2
  event.waitUntil((async () => {
    await self.registration.showNotification(n.title, {
      body: n.body, lang: n.lang ?? 'zh-CN', tag: n.tag, renotify: !!n.tag, data,
      icon: '/pwa-192x192.png', badge: '/badge-mono-96.png',
      actions: (n.data?.actions ?? []).slice(0, max),
    } as NotificationOptions)
    const b = Number(p?.app_badge)
    if (!Number.isNaN(b) && 'setAppBadge' in self.navigator)
      await (b > 0 ? (self.navigator as any).setAppBadge(b) : (self.navigator as any).clearAppBadge()).catch(() => {})
  })())
})

self.addEventListener('notificationclick', (event) => {
  const d = event.notification.data ?? {}; event.notification.close()
  const url = new URL(d.navigate ?? '/', self.location.origin).href
  if (event.action === 'accept' || event.action === 'decline') {        // Android only
    event.waitUntil((async () => {
      const ok = await fetch('/api/notify/respond', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tok: d.tok, response: event.action }) }).then(r => r.ok).catch(() => false)
      for (const c of await self.clients.matchAll({ type: 'window', includeUncontrolled: true }))
        c.postMessage({ type: 'task-updated', taskId: d.taskId })
      if (!ok) await self.clients.openWindow(url + (url.includes('?') ? '&' : '?') + 'respond=' + event.action)
    })()); return
  }
  event.waitUntil((async () => {                                          // body tap
    const win = (await self.clients.matchAll({ type: 'window', includeUncontrolled: true }))[0] as WindowClient | undefined
    if (win) { await win.focus(); win.postMessage({ type: 'navigate', url }) } // avoids WindowClient.navigate() bugs on iOS
    else await self.clients.openWindow(url)                                   // call openWindow only once
  })())
})
```
`tok` is an HMAC-signed `{taskId, memberId, response-allowed, exp}`, so the action works even when no cookie session is available. `/api/notify/respond` must be idempotent, and it cancels the scheduler's follow-up nudges.

**Server send (`server/push.ts`)**
```ts
import webpush from 'web-push'
webpush.setVapidDetails(process.env.VAPID_SUBJECT!, process.env.VAPID_PUBLIC_KEY!, process.env.VAPID_PRIVATE_KEY!) // subject: mailto:ops@yourdomain (never localhost)
const POLICY = { nudge: { TTL: 3600, urgency: 'high' }, reminder: { TTL: 1800, urgency: 'high' },
                 chat: { TTL: 6 * 3600, urgency: 'normal' }, digest: { TTL: 12 * 3600, urgency: 'normal' } } as const
export async function sendPush(sub: Row, m: { kind: keyof typeof POLICY; title: string; body: string; url: string;
  taskId?: string; tok?: string; badge?: number; withActions?: boolean }) {
  const payload = { web_push: 8030, app_badge: m.badge != null ? String(m.badge) : undefined,
    notification: { title: m.title, body: m.body, navigate: m.url, lang: 'zh-CN', tag: m.taskId ? `task-${m.taskId}` : undefined,
      data: { taskId: m.taskId, kind: m.kind, tok: m.tok,
        actions: m.withActions ? [{ action: 'accept', title: '✅ 可以' }, { action: 'decline', title: '🙅 不行' }] : [] } } }
  const body = JSON.stringify(payload)
  if (Buffer.byteLength(body) > 3000) throw new Error('push payload too large; shorten body')
  const topic = m.taskId ? ('t' + m.taskId.replace(/[^A-Za-z0-9_-]/g, '')).slice(0, 32) : undefined
  try {
    await webpush.sendNotification({ endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } }, body,
      { ...POLICY[m.kind], topic, timeout: 10_000 })
    await db.pushSubs.markSuccess(sub.id)
  } catch (e: any) {
    const s = e?.statusCode
    if (s === 404 || s === 410) return db.pushSubs.delete(sub.id)              // expired / uninstalled
    if (s === 429 || s >= 500) return queue.retry(sub.id, m, Number(e.headers?.['retry-after'] ?? 60))
    if (s === 400 || s === 403 || s === 413) log.error({ s, body: e.body, endpoint: sub.endpoint }, 'push config/payload error')
    await db.pushSubs.incFail(sub.id); throw e
  }
}
```
Send to **every** subscription a member has (they may have more than one device). If a member has no successful delivery in N days, show an in-app "通知可能已失效，请重新开启" banner and lean on the digest.

## 7. Risks and mitigations
1. **iOS subscriptions die silently.** WebKit 273063 is open, and iOS fires no `pushsubscriptionchange`. Mitigations: sync the subscription on every launch, track `last_success_at` (a 201 from Apple does not prove the notification was displayed), keep an in-app inbox and badge, and ask people to re-enable after iOS updates.
2. **iOS tap opens the start URL instead of the deep link.** WebKit 263687 is open, though not reproducible on iOS 26.0. Mitigation: declarative `navigate`, plus a router that reads `?src=push` and a postMessage fallback.
3. **No action buttons on iOS.** The deep-linked task card must make 可以/不行 a single tap. ntfy is the only route to native iOS buttons.
4. **iOS asks for the mic on every launch.** Explain it once in onboarding copy, keep the app a single-page app, and fall back to text input.
5. **Android without GMS** gets no web push. Detect it by checking whether subscribe() fails or whether the endpoint host is not `fcm.googleapis.com`, then offer ntfy (F-Droid/APK) or digest-only.
6. **Origin churn** (tunnel hostnames) forces re-onboarding. Fix the domain early.
7. **The WeChat in-app browser** can't install the app or receive push. Onboarding must send people to Safari or Chrome.


## Unverified

- iOS notification action buttons: MDN BCD marks `actions`/`maxActions`/`NotificationEvent.action` unsupported in Safari and iOS, and developer forums report only the default action. I found no explicit Apple statement, and none for iOS 26 or 27.
- MDN BCD lists `notificationclick` as unsupported on safari_ios, which contradicts WebKit bug reports where openWindow()/navigate() work on iOS 26.0. Treat it as a BCD data gap; test on device.
- Whether WebKit's declarative parser tolerates custom members inside `notification.data` (spec says `data` is any JSON), and whether `app_badge` must be a string (WebKit example uses "1") or a number.
- Whether Home Screen web push can use the Time Sensitive interruption level or otherwise break through Focus; no documentation found.
- That Chrome on Android cannot deliver web push on devices without Google Play services (Huawei post-2019, mainland-China ROMs). This is strongly implied by FCM dependence, but I found no current Google doc. Web push support in Huawei Browser / HarmonyOS NEXT is unknown.
- Whether Chrome Android offers a one-time 'Allow this time' microphone permission, and how it behaves inside an installed WebAPK.
- Whether `pushManager.subscribe()` can be called without a user gesture on iOS once permission is already granted (the re-subscribe-on-launch path).
- Whether ntfy's iOS app runs `http` action buttons in the background without opening the app; the docs only say the feature is 'supported on' iOS.
- Actual Tailscale Funnel bandwidth limits (documented only as 'non-configurable') and current free-plan details.
- How iOS 26 handles `apple-mobile-web-app-status-bar-style` and `theme-color` in standalone mode; reports are mixed and come from forums.
- Whether web-push's per-send JWT signing conflicts in practice with Apple's guidance not to refresh the JWT more than once per hour (assumed harmless at family volume).
- I did not read the Safari 26.1 and 26.2 WebKit feature posts. The 26.3, 26.4, 26.5, 26.6, 27.0 and WWDC26 posts show no push or Home Screen changes.
- ntfy.sh annual pricing, and whether upstream poll requests from a self-hosted server count against the free 250 messages/day limit.
- MediaRecorder default MIME type on current iOS (audio/mp4 vs webm/opus); sources conflict, so choose it at runtime.

## Sources

- https://webkit.org/blog/16535/meet-declarative-web-push/
- https://webkit.org/blog/16574/webkit-features-in-safari-18-4/
- https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/
- https://webkit.org/blog/17333/webkit-features-in-safari-26-0/
- https://webkit.org/blog/18325/webkit-features-for-safari-27-0/
- https://webkit.org/blog/18178/webkit-features-for-safari-26-6/
- https://webkit.org/blog/17938/webkit-features-for-safari-26-5/
- https://webkit.org/blog/17862/webkit-features-for-safari-26-4/
- https://webkit.org/blog/17798/webkit-features-for-safari-26-3/
- https://webkit.org/blog/17967/news-from-wwdc26-webkit-in-safari-27-beta/
- https://developer.apple.com/documentation/usernotifications/sending-web-push-notifications-in-web-apps-and-browsers
- https://w3c.github.io/push-api/
- https://pushpad.xyz/blog/declarative-web-push
- https://github.com/mdn/browser-compat-data
- https://bugs.webkit.org/show_bug.cgi?id=215884
- https://bugs.webkit.org/show_bug.cgi?id=327237
- https://bugs.webkit.org/show_bug.cgi?id=273063
- https://bugs.webkit.org/show_bug.cgi?id=263687
- https://developer.apple.com/forums/thread/726793
- https://developer.apple.com/forums/thread/728796
- https://github.com/web-push-libs/web-push
- https://www.npmjs.com/package/web-push
- https://github.com/draphy/pushforge
- https://github.com/vite-pwa/vite-plugin-pwa/releases
- https://vite-pwa-org.netlify.app/guide/inject-manifest.html
- https://vite-pwa-org.netlify.app/guide/pwa-minimal-requirements.html
- https://github.com/vite-pwa/assets-generator
- https://web.dev/articles/install-criteria
- https://developer.mozilla.org/en-US/docs/Web/Progressive_web_apps/Guides/Making_PWAs_Installable
- https://developer.chrome.com/blog/notification-actions
- https://developer.chrome.com/blog/web-push-interop-wins
- https://firebase.google.com/docs/cloud-messaging/android/message-priority
- https://docs.ntfy.sh/publish/
- https://docs.ntfy.sh/config/
- https://docs.ntfy.sh/subscribe/phone/
- https://docs.ntfy.sh/install/
- https://docs.ntfy.sh/releases/
- https://ntfy.sh/#pricing
- https://tailscale.com/kb/1223/funnel
- https://tailscale.com/kb/1311/tailscale-funnel
- https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/do-more-with-tunnels/trycloudflare/
- https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/do-more-with-tunnels/local-management/create-local-tunnel/
- https://blog.addpipe.com/getusermedia-getting-started/
- https://wwdcnotes.com/notes/wwdc23/10120
- https://bugs.webkit.org/show_bug.cgi?id=181849
- https://www.theregister.com/2024/03/02/apple_reverses_pwa_decision/
- https://benfrain.com/ios26-safari-theme-color-tab-tinting-with-fixed-position-elements/
