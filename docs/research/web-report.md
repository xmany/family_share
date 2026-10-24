# Web app: implementer report

The web app (PWA) is built under `src/web/`, plus `scripts/make-icons.mjs`. Both typechecks are clean, `npm run build:web` succeeds, and `npx vitest run src/web` passes 34 tests. Nothing outside `src/web/` and `scripts/` was touched, nothing was installed, and nothing was committed.

**How it was checked.** I ran the UI at phone size in light and dark mode against a throwaway mock of `src/shared/api.ts` (kept in my scratchpad, not the repo). I clicked through every screen: chat send and its "处理中…" bubble, an error reply, undo, voice, board accept/decline, item detail, settings, invite QR, the welcome after joining, the signed-out screen and `/t/:token`. For voice I faked the microphone and drove the button with scripted touches, so a real mic wasn't used. The voice upload arrived as `voice.webm` with the right type, and sliding up cancelled it. The service worker could not be registered in that browser at all (even a hand-written register call fails), so I ran the built `dist/web/sw.js` in a simulated worker in Node instead, and push, button and tap handling all behaved as specified. **Nothing has been tried on a real iPhone or Android phone yet.** Push permission, the iOS keyboard layout and the real microphone still need that.

Fixed during the visual pass:
- **Same avatar for both parents:** 老公 and 老婆 both showed "老". Two-character names now show in full; longer Chinese names show their last two characters.
- **Lost clicks on desktop:** the tab bar hides while you type in chat, and on desktop that swallowed clicks. It now only hides on touch screens.
- **Welcome card out of view:** the card after joining sat at the top of a chat that opens scrolled to the bottom. It now sits just above the input and goes away once you send something.
- **Wrong iPhone text on Android:** a phone-emulation case got iPhone instructions. Detection now treats any Android user agent as not iOS.

**Routing.** `lib/router.ts` is a small path router with all the routes from the brief. Unknown query parameters are ignored, and `?src=push` is removed from the URL. `/join` and `/t/:token` render without a session. Back/forward restores scroll position.

**Push.** The service worker is registered at startup so its registration is ready before anyone taps.
- **Turning it on:** "开启通知" calls `requestPermission()` (or `subscribe()` if already granted) as its first wait. If iOS still refuses, it says "请再点一次".
- **Every launch:** the app re-checks permission and the subscription, re-subscribes if the server key changed, and re-posts it to the server.
- **Messages from the worker:** it listens for `navigate` and `board_changed`.
- **Updates:** after a new worker takes over, the app reloads only when it next goes to the background.

**Recording.** `lib/recorder.ts` chooses the audio format at runtime: `audio/mp4` first on Apple devices, `audio/webm;codecs=opus` first elsewhere, falling back down a list. There is no timeslice and the cap is 60 s. The mic stream stays open while the page is visible and is released when hidden or after 60 s idle. The button handles press-and-hold, sliding up more than 60 px to cancel, presses under 0.6 s, and the iOS permission prompt interrupting the press. Uploads are named `.m4a` for mp4 and `.webm` for webm.

**What the server team must honour:**
- **Session and headers:** cookie session on every `/api/*` except `POST /api/auth/join` and `/api/t/*`, with 401 when it's missing. Every mutation sends `X-Family-Share: 1`, including `POST /api/auth/logout` and `DELETE /api/push/subscriptions`; the delete has a JSON body `{endpoint}`.
- **Errors:** `{error:{code,message}}` with the message in Chinese, because the UI shows it as is. Invalid join tokens should return 400/401/404/410. Dead `/t/` tokens should return 401/403/404/410.
- **Live updates (`/api/stream`):** must use unnamed events, i.e. `data:` lines only with no `event:` field. A named event would be silently ignored. Send `hello` first and a ping at least every 70 s, or the client treats the connection as dead.
- **Voice:** multipart field `audio` (filename `voice.m4a` / `voice.webm` / `.ogg` / `.aac`; the type may include `;codecs=`), plus a `durationMs` field. STT failures use code `stt_failed` or `stt_unavailable`. Utterance requests time out on the client after 120 s.
- **Notification buttons:** the worker POSTs `/api/notifications/:id/action` with `{action}` using credentials and the CSRF header. Any non-2xx response makes it open the item instead. It never posts the `open` action.
- **Push payload:** must carry `notification.data.notificationId`, and `navigate` must be an absolute URL on the same origin.
- **Item updates (`PATCH /api/items/:id`):** due-time changes send only `dueAt`, or only `dueDate`, or both `null` to clear. The status buttons send `{status}` with `in_progress`, `blocked`, `dropped` or `open`. When the requester resends a declined request, it sends `{status:'pending'}`.
- **Item detail:** `GET /api/items/:id` must still work for items closed more than 7 days ago.
- **WeChat mode:** sent as `PUT /api/settings {channels:[{channel:'wechat', enabled: mode!=='off', config:{mode}}]}`.
- **Static serving:** serve `index.html` for `/join`, `/t/*`, `/item/*` and the other app paths. Serve `sw.js` and `index.html` with `no-cache`.

**Outside my area:**
- **Manifest colours:** `vite.config.ts` sets the manifest colours to `#ffffff`. The app background is `#f5f1ea` (dark `#171513`), and adding `id: '/'` is recommended.
- **Undeclared dependency:** `sw.ts` imports `workbox-routing`, which is only installed because `workbox-precaching` depends on it. It's worth adding to devDependencies explicitly.
- **Weaker iOS invite flow:** iPhone Home Screen apps keep their own cookies, so the signed-out screen lets you paste an invite link to log in.
- **Board sections:** to keep anything from being hidden, 进行中 shows both my started items and everything other family members have open.

Files are in `/Users/xman/dev/family_share/src/web/`:
- `index.html`, `main.tsx`, `App.tsx`, `index.css`, `scroll.ts`, `sw.ts`
- `lib/`: `api.ts`, `sse.ts`, `push.ts`, `platform.ts`, `recorder.ts`, `router.ts`, `store.ts`, `board.ts`, `labels.ts`, `invite.ts`, `toast.ts`, plus tests `recorder.test.ts`, `platform.test.ts`, `router.test.ts`, `board.test.ts`
- `components/`: `Composer.tsx`, `items.tsx`, `setup.tsx`, `InvitePanel.tsx`, `ui.tsx`, `Icons.tsx`, `Logo.tsx`
- `pages/`: `ChatPage.tsx`, `BoardPage.tsx`, `ItemPage.tsx`, `WeeklyPage.tsx`, `SettingsPage.tsx`, `JoinPage.tsx`, `LinkPage.tsx`
- `public/icons/`: `icon-192.png`, `icon-512.png`, `icon-maskable-512.png`, `apple-touch-icon.png` (opaque), `badge-96.png`

The icon generator is `/Users/xman/dev/family_share/scripts/make-icons.mjs`.

# Web app: review

I found and fixed 17 real problems in the web app. Both typechecks, `npm run build:web` and `npx vitest run src/web` (35 tests) all pass. I only edited `src/web/`; nothing was committed, and nothing has been tried on a real phone yet.

Every API call matches `api.ts`, and the paths and `audio` field also match the routes in `src/server/http/app.ts`.

## Fixed

**Security**
1. **QR code** (`components/InvitePanel.tsx`): it was rendered with `dangerouslySetInnerHTML`. It is now an `<img>` with a `data:image/svg+xml` URL, so no HTML from data reaches the page.
2. **Unsafe links from push or the service worker** (`lib/router.ts` `navigate()`): a URL on another origin, including `javascript:`, was passed to `location.assign`. Now only http(s) URLs leave the app.
3. **Service worker link handling** (`sw.ts` `absoluteUrl()`): it now always opens or focuses a URL on our own origin. A web URL on another host keeps its path on our origin, and anything else opens `/`.

**Joining from WeChat** (`pages/JoinPage.tsx`, `lib/invite.ts`)

4. Opening an invite inside WeChat joined there and removed the token from the address bar. WeChat's ··· → 在浏览器打开 then opened `/join` with no token, so the invite was lost. In WeChat the token now stays in the URL, and the page explains how to continue in Safari or Chrome. It has 复制邀请链接 and 先在微信里看看; the second joins in WeChat and only then removes the token. Elsewhere, the token is removed through the router's replace, so the router's own copy of the URL updates too.
5. The token reader now ignores anything glued onto the end of the fragment (e.g. `?from=singlemessage`). There is a new test for this.

**Push** (`lib/push.ts`, `components/setup.tsx`)

6. The first tap on 开启通知 could fail while the new service worker was still installing: subscribe throws `InvalidStateError`, which the code treated as a stale key, and the user saw 开启通知失败了. After permission is granted, it now waits for an active worker. The stale-key replacement only runs when a subscription really exists. The launch-time `syncSubscription` uses the same wait.
7. The iPhone add-to-Home-Screen guidance is now chosen by checking iOS and "not installed" first, rather than relying on push APIs being absent. Installed apps on iOS older than 16.4 get their own message (升级到 iOS 16.4) instead of "这个浏览器不支持通知".
8. **Notification buttons** (`sw.ts`): the button request now times out after 6 s. Chrome only allows opening a window for about 10 s after a tap, so the fallback of opening the item still works when the server is slow.

**Recorder** (`components/Composer.tsx`, `lib/recorder.ts`)

9. React's touch listeners are passive, so iOS long-press behaviour (text selection, the callout, a cancelled pointer) could end a hold. The mic button now cancels `touchstart` and `selectstart` with native listeners.
10. If the app was hidden mid-press, the recorder dropped the recording but the button stayed in "recording" and ignored all later presses. The recorder now reports the interruption and the button resets. The recorder is also recreated after it is disposed.

**Board** (`lib/board.ts`, test updated)

11. A request I sent that came back declined sat under 我在等别人, although nobody is working on it and it is my decision now. It now goes to 我的待办. Requests I sent that are still with the other person (pending, accepted, in progress, blocked) stay in 我在等别人.

**Item page** (`pages/ItemPage.tsx`)

12. Someone who sent a request could not withdraw it while it was pending. There is now a "在等X回复 · 不需要了" control, which sets the status to `dropped` after a confirm.
13. If a time picker reports seconds ("08:30:00"), the edit form now trims it to HH:MM before converting with `zonedToUtc`. Before, saving failed with 时间格式不对.

**Copy and layout**

14. **Voice error text** (`pages/ChatPage.tsx`): voice errors repeated the server's advice ("…键盘上的语音输入。可以再说一次，或用键盘…"). The hint is now added only when the server's message lacks it, and the "speech-to-text not configured" case gets its own wording.
15. **Decline button** (`components/items.tsx`): its large size needed about 158 px in a roughly 146 px slot at 360 px width, so I shortened it to 确定做不了. The reason box also gets an `aria-label`, as does the note textarea on the item page.

**Accessibility**

16. Focus rings on links inside cards were clipped by the cards' `overflow: hidden`. They are now drawn inside the card (`index.css`). The "open in the app" link on `/t/` now has a 44 px tap target.

**Robustness**

17. **Live updates** (`lib/sse.ts`): when the live connection kept failing (e.g. a 401), it retried forever without the app noticing. It now refetches the board once after three failures, so a lost session reaches the sign-in screen.
18. **Profile settings** (`pages/SettingsPage.tsx`): the WeChat bind check reloads settings every 5 s, and each reload wiped name/alias edits in progress. It no longer does.

## Not changed (outside `src/web` or `scripts`)
- **Manifest** (`vite.config.ts`): `background_color` and `theme_color` are still `#ffffff`. They should be `#f5f1ea`, and `id: '/'` should be added.
- **Dependency** (`package.json`): `workbox-routing` is used by `sw.ts` but isn't listed as a dependency.
- **Deep link lost on sign-in:** opening `/item/:id` while signed out and then pasting an invite lands on `/` rather than the item. This is minor.

## Verification
- **Browser pass at 360 px, light and dark:** I ran Vite against a throwaway mock API in the scratchpad. A script checked every route plus the open decline, snooze, edit and invite panels: no element overflowed the 360 px width.
- **WeChat join:** with a WeChat user agent, the new join screen rendered. 先在微信里看看 joined, removed the token and showed the welcome card.
- **Mic button**, driven with a fake microphone and scripted touches:
  - `touchstart` is cancelled.
  - Hiding the app mid-hold resets the button.
  - Sliding up 80 px cancels.
  - A normal hold uploads to `/api/utterances/voice`.
- **Chat:** answering a clarification shows "处理中…", then the error bubble with the new wording.

Still untested: a real microphone, real push permission and the iOS keyboard layout on actual phones.