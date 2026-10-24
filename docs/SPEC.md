# family_share v0 — build spec

A self-hosted family coordination app for one Chinese-speaking family (one iPhone, one Android, later grandparents/kids).
People say or type things in Chinese ("明天早上你能带孩子出去吗？我九点有个会"); Claude turns that into changes on a shared
board; a deterministic scheduler delivers reminders, request follow-ups and digests.

The **contracts are already written and are authoritative**. Implement against them; do not change them without a very good
reason (and if you must, change both sides and say so in your report):

| File | What it defines |
|---|---|
| `src/shared/types.ts` | Domain types (Member, Item, ItemEvent, Utterance, ScheduledNotification, PushPayload …) |
| `src/shared/api.ts` | Every HTTP route, request and response body, SSE `ServerEvent` |
| `src/server/db/schema.ts` | SQLite schema (snake_case columns) |
| `src/server/db/db.ts` | `openDb(path)`, `parseJson` |
| `src/shared/time.ts` (re-exported by `src/server/time.ts`) | Timezone helpers + `Clock`/`FixedClock` (tested); pure Intl, usable from the web app |
| `src/server/ids.ts` | `newId(prefix)`, `newSecret()`, `sha256Hex()` |
| `src/server/bus.ts` | In-process event bus (`broadcast(ServerEvent)`, `wakeScheduler()`) |
| `src/server/notify/outbox.ts` | Notification outbox (enqueue with dedupe, due rows, cancel, mark sent/failed) |
| `src/server/domain/types.ts` | `Domain` interface, `Actor`, `DomainError`, input types |
| `src/server/ai/types.ts` | `Interpreter` interface |
| `src/server/notify/types.ts` | `NotificationChannel`, `Notifier` interfaces |
| `src/server/stt/types.ts` | `SttProvider` interface, `SttError` |
| `src/server/scheduler/types.ts` | `Scheduler` interface |
| `src/server/config.ts` | `loadConfig()` → `Config` (env vars) |
| `src/server/context.ts` | `AppContext` wiring type |
| `src/server/tokens.ts` | App secret (kv) + signed item-link tokens for `/t/:token` (tested) |

Stack: Node 24, TypeScript (strict, `moduleResolution: Bundler`, import without extensions), better-sqlite3 (sync API),
Hono + @hono/node-server, `@anthropic-ai/sdk`, `web-push`, zod 4, vitest. Web: Vite 8 + React 19 + Tailwind 4 +
vite-plugin-pwa (injectManifest, `src/web/sw.ts`). Tests are colocated `*.test.ts` and run with `npx vitest run`.
Use `FixedClock` in tests; never call `new Date()`/`Date.now()` for business logic — take time from `clock.now()`.

## 1. Concepts

- **Item kinds**: `task` (one owner does it), `request` (one member asked another; needs accept/decline), `idea`
  (no deadline; resurfaced weekly), `reminder` (a ping at a time).
- **Exactly one owner** per item (ideas may be unowned). Requests: `requestedBy` = asker, `ownerId` = asked.
- **Never hard-delete.** "不要了/算了" → status `dropped`.
- **Everything is an event.** Every change writes an `events` row with `payload.before` / `payload.after`
  (only the changed fields) so the activity feed, item history and undo all come from one log.
- **Every notification goes through the outbox** (`notifications` table), written in the same transaction as the
  change that caused it. The scheduler delivers it. Nothing is "remembered" by the LLM.

## 2. Status rules (domain enforces)

| Kind | Allowed statuses | Notes |
|---|---|---|
| task, idea, reminder | open, in_progress, blocked, done, dropped | |
| request | pending → accepted / declined; accepted → in_progress / blocked / done; any → dropped | only the owner may accept/decline; anyone may complete or drop; the requester may re-open a declined request by updating it (status back to pending re-sends it) |

- Setting status `done` through `updateItem` behaves exactly like `completeItem` (sets `completedAt`, cancels scheduled
  notifications, notifies the requester for requests). `dropped` also cancels scheduled notifications.
- Re-opening a closed item clears `completedAt` (and a snooze that is still running, §3).
- Dropping an open request notifies the other side (§3); after a decline it notifies nobody.
- `kind` may change between task / idea / reminder; never to or from request.
- `dueAt` and `dueDate` are mutually exclusive: setting one clears the other.
- Validation errors throw `DomainError('invalid', '<Chinese message>')`; unknown ids `DomainError('not_found', …)`;
  responding to someone else's request `DomainError('forbidden', …)`.
- Titles: trimmed, 1–200 chars. Details/notes ≤ 2000 chars. Member ids must exist. `sendRequest` to yourself is invalid
  (create a task instead).
- `lastActivityAt` updates on every event/note for the item.

## 3. Notification policy (domain enqueues; scheduler delivers)

All times local to `family.timezone`. Every row has a `dedupeKey`; re-enqueueing is harmless. When an item's timing
changes, cancel its old scheduled `due` rows and plan new ones. A new `dueAt`/`dueDate` (not clearing it) or re-opening
a closed item also ends a snooze that is still running: `snoozedUntil` is cleared and its `snooze:` row cancelled (the
event records `snoozedUntil`, so undo restores both), because the scheduler holds a snoozed item's due pings back.
When an item closes, cancel all its scheduled rows. Never notify the actor about their own action.

| Trigger | To | kind | When | Quiet hours | dedupeKey | actions |
|---|---|---|---|---|---|---|
| sendRequest | owner | request_new | now | respected unless due within 12 h or priority high | `request_new:<id>:<n>` (n = times (re)sent) | accept, decline |
| sendRequest | owner | request_followup | when request_new reaches the owner (now, or the end of the owner's quiet hours when it is held back) + `REQUEST_FOLLOWUP_MIN` (default 120 min), or 3 h before dueAt if sooner (never < 30 min after it reached them) | respected | `request_followup:<id>:<n>` | accept, decline |
| sendRequest | requester | request_noreply | when request_new reaches the owner + `REQUEST_NOREPLY_MIN` (default 360 min), or 1 h before dueAt if sooner (never < 30 min after it reached them) | respected | `request_noreply:<id>:<n>` | open |
| respondToRequest | requester | request_answered | now | respected | `request_answered:<id>:<response>:<n>` | open |
| complete a request (done) | requester | request_answered | now | respected | `request_answered:<id>:done:<n>` | open |
| drop an open request (dropped) | the other side: the requester when the owner drops it, the owner when the requester drops it (both when a third member does) | request_answered | now | respected | `request_answered:<id>:dropped:<n>` (the owner's row gets `:<ownerId>` appended when both are told) | open |
| (any) owner changes to another member | new owner | assigned | now | respected | `assigned:<id>:<ownerId>:<eventId>` | done, open |
| dueAt on task/request (time known) | owner | due | dueAt − 60 min; plus 20:00 the evening before when dueAt is before 10:00 local and > 12 h away | the 60-min one ignores quiet hours; the evening one respects them | `due:<id>:<dueAt>` / `due_eve:<id>:<dueAt>` | done, snooze_tonight |
| dueDate on task/request (day only) | owner | due | 09:00 on dueDate (skip if already past) | respected | `due:<id>:<dueDate>` | done, snooze_tomorrow |
| kind reminder with dueAt | owner | explicit | exactly dueAt | ignored | `reminder:<id>:<dueAt>` | done |
| createItem remindAt / setReminder | member | explicit | fireAt | ignored | `explicit:<id or member>:<fireAt>` | done, open |
| snoozeItem | owner | due | `until` (until then the item's own due / reminder pings are skipped, see below) | respected | `snooze:<id>:<until>` | done, snooze_tomorrow |

Responding to / completing / dropping a request cancels its pending `request_followup` and `request_noreply` rows.
Dropped requests: no notice after a decline (both sides already know) or for a request that was already closed; none to
an owner whose `request_new` for this round was still waiting in the outbox (they never got the request); the text is
`老婆不做了：带孩子出去` (the owner backs out) or `老公取消了：买牛奶` (the requester takes it back), body = the reason
given, else `要不要换个安排？` / `不用做了`. Re-opening a request cancels its undelivered done / dropped notices.
Titles/bodies are short Chinese, e.g. title `老公请你：带孩子出去`, body `周六 08:30 · 他九点有个会`. Use member names, never ids.
They are worded when the row is planned and **re-rendered at delivery time** from the item's current state, so
"今天 / 明天" are right after a quiet-hours deferral, a retry or downtime (request_answered / assigned keep their title,
which names who acted; explicit setReminder rows, stale / digest / weekly rows and done / dropped answers keep their text).

The **scheduler** additionally (generators, every tick, dedupe keys make them idempotent):

- **Relevance check at delivery**: skip (`markSkipped`) a `request_new` / `request_followup` / `request_noreply` row if
  the item is no longer pending (or the recipient changed); `request_followup` / `request_noreply` once the request is
  due (dueAt reached, or the dueDate is over: `past_due`); any other item-bound row if the item is closed, except
  `request_answered` (an answer, a completion or a drop always concerns a changed, often closed, item); a `due` row if
  the item's due time changed since it was planned (compare dedupe key); the item's own due / reminder pings (`due:`,
  `due_eve:`, `reminder:` keys) while it is snoozed (`snoozedUntil` in the future: `snoozed`; the `snooze:` row itself
  goes out, extra setReminder pings too); a `due` / `explicit` ping when the same member already got a ping about the
  same item in the last minute (`duplicate`, e.g. remindAt = dueAt − 60 min; a setReminder row with its own message still
  goes out).
- **Quiet hours**: if `respectQuietHours` and fire time is inside the recipient's quiet hours, `outbox.defer` to quiet end.
  A `request_followup` / `request_noreply` whose deferral would land at or after the request's due time is skipped
  (`past_due`) instead. When a `request_new` is deferred (or delivered late), that round's follow-up and no-reply move to
  at least the delivery time + their delays (never earlier).
- **Retries**: transient failure → retry after 1, 5, 15, 60 min (`markFailed` with retryAt), permanent (410 etc.) → drop that
  endpoint. A member with no reachable channel → `markSkipped('no_channels')` (the board still shows everything).
- **Daily digest** at each member's `digestTime` (skip if null or nothing to say): today's items, overdue, requests waiting
  for their answer, what they're waiting on from others. `digest:<memberId>:<localDate>`.
- **Stale nudge**: active task/accepted request with no due date, `lastActivityAt` > 5 days ago, not snoozed → owner at the
  next 19:00, at most every 4 days: `stale:<id>:<floor(daysSinceActivity / 4)>`. Body offers: pick a time, break it down,
  or drop it. Actions: snooze_tomorrow, done, open.
- **Weekly sync** Sunday 19:00 to adults: done this week, stuck (> 7 days open), ideas waiting for a decision, next week's
  dated items. `weekly:<memberId>:<localDate>`. Url `/weekly`.
- **Catch-up after downtime**: a row more than 15 min late is delivered with title prefix `（迟到）`; a `due`, `digest`, `weekly`,
  `stale` or `request_followup` row more than 12 h late is skipped (`markSkipped('too_late')`).

## 4. Interpreter (Claude)

See `docs/research/claude-api-brief.md` for the API brief (model, effort, fallbacks, tool loop, caching, errors).

- One utterance = one self-contained Messages request: stable system prompt + tools (cached), then a user message
  containing the volatile context and the utterance. No long chat history is replayed; continuity comes from the
  context block (recent utterances + any open clarification).
- Context block (compact, Chinese labels fine): current local datetime with weekday and timezone
  (`describeNowForPrompt`), the speaker, all members (id, name, aliases, role), all active items
  (id, kind, status, title, owner, requester, due, snoozed, the item's upcoming extra pings from setReminder / remindAt —
  `另有提醒 明天 07:00（2026-10-22 07:00）→ 老公`, up to 3 —, last activity, latest 2 notes truncated), titles of items closed
  in the last 7 days (with ids), the last 8 utterances family-wide (speaker, text, reply), and — if this utterance answers a
  clarification — that question and options.
- Tools (strict JSON schemas, `additionalProperties: false`, no nullable fields, ≤ 24 optional params total): `search_items`,
  `create_item`, `update_item`, `add_note`, `send_request`, `respond_to_request`, `complete_item` (resolution done|dropped),
  `snooze_item` (preset tonight|tomorrow|weekend|next_week|custom; silences the item until then and pings once — if the
  thing itself moved, `update_item` due_change set, which also clears the snooze), `set_reminder`, `cancel_reminder`
  (item_id, remind_date, remind_time: cancels that item's extra pings at that local time via `Domain.cancelReminder`; the
  item and its due ping stay), `ask_clarification`. Dropping a request through `complete_item` reports whether the other
  side was notified (`notified` / `not_notified` / `withdrawn_before_delivery`). Exact shapes are in
  `docs/research/claude-api-brief.md` §3. Each maps to a Domain call with actor `{ type: 'ai', memberId: speaker, utteranceId }`.
  **Times are local**: the model sends `YYYY-MM-DD` and optional `HH:MM`; the server converts with `zonedToUtc` in the family
  timezone (date only → `dueDate`, date+time → `dueAt`). Never ask the model for UTC offsets. Validate with zod before calling
  the domain; return `is_error: true` tool results (`{ok:false, code, message}`) so Claude can correct itself.
- Ownership: `create_item` is for the speaker's own items or unowned ideas. Asking anyone else goes through `send_request`
  (that's the point: they must accept). `update_item` may change `owner_id` only when the speaker explicitly hands an item
  over ("这个交给她"), which triggers the `assigned` notification.
- `ask_clarification` ends the turn: the utterance is finished with status `clarify` and the question/options.
- The context includes a 3-week calendar table (每天: date, weekday, 今天/明天/后天 labels, and the lunar date via
  `Intl.DateTimeFormat('zh-CN-u-ca-chinese', …)`) so the model never computes weekdays or lunar dates itself, and a
  time-of-day defaults line: 早上 08:00，上午 10:00，中午 12:00，下午 15:00，傍晚 18:00，晚上 20:00，睡前 21:30，下班后 18:30.
- Script: titles/notes are stored as spoken; duplicate checks and search compare Simplified-normalized text (opencc-js t2s).
  The reply uses the speaker's script (member.language zh-CN → Simplified).
- Repeating tasks (每周二倒垃圾) are not supported in v0: create the next occurrence only and say so in the reply.
- Loop cap: `config.anthropic.maxIterations` (default 6) model calls per utterance; on cap or API failure, finish with status `error` and a short Chinese message;
  changes already applied stay (and remain undoable).
- Behaviour rules for the system prompt: resolve references to existing items before creating ("那个柜子" = the open
  cabinet item); one item per real-world thing; requests for other people use `send_request` (never `create_item` with
  someone else as owner unless they explicitly say "记给她/assign"); "我" = speaker, "你" in a message addressed to the
  spouse usually = the other adult; vague times use the time-of-day defaults and the reply states the assumed time; ask instead of guessing when two items match or the owner is unclear;
  updates like "挂出去了，80块，周日可能有人来拿" → update status/notes + follow-up, not a new item; reply in the speaker's
  language (default Simplified Chinese), one or two short sentences, no markdown. When the utterance source is `wechat`
  the reply lands in a template field cut after about 20 characters (§7): one sentence of at most 18 characters, key fact
  first, no opener (已请老公明天18:30买奶，待确认); clarification questions there follow the same limit with short options,
  and board questions get the count plus the one or two most urgent items (还有5件，最急：明天交水费).
- If `ANTHROPIC_API_KEY` is missing, `enabled = false` and interpret() finishes the utterance with an error explaining that AI
  isn't configured (manual buttons still work).

## 5. HTTP server

`src/shared/api.ts` lists every route. Additional rules:

- Auth: invite links `${PUBLIC_URL}/join#token=<secret>` (reusable up to 5 times until it expires after 7 days — iOS
  home-screen apps don't share Safari's cookies, so a person may need to join twice; sha256 stored; never consumed by GET —
  WeChat link previews fetch URLs). `POST /api/auth/join`
  creates a session: cookie `fs_session` = random secret (sha256 stored), httpOnly, SameSite=Lax, Secure when PUBLIC_URL
  is https, Max-Age 400 days. All other `/api/*` routes require a valid session; 401 otherwise.
- Mutations (`POST/PUT/PATCH/DELETE`) require header `X-Family-Share: 1` (403 otherwise).
- Errors: `{ error: { code, message } }` with 400 invalid / 401 / 403 forbidden / 404 not_found / 409 conflict / 422
  stt_failed / 500. DomainError maps to its code.
- Voice: `POST /api/utterances/voice` multipart field `audio` (≤ 10 MB, ≤ 90 s). Save to `DATA_DIR/audio/<utteranceId>.<ext>`,
  transcribe with the configured SttProvider, then interpret with source `voice`. If STT isn't configured → 422
  `stt_unavailable`.
- `POST /api/notifications/:id/action` is called by the service worker from a notification button; it must only act on a
  notification that belongs to the session's member.
- SSE `GET /api/stream`: send `hello`, then every Bus `server_event`, plus `ping` every 25 s.
- In production the same server serves `dist/web` (SPA fallback to index.html for non-/api paths) with correct caching
  (index.html and sw.js `no-cache`; hashed assets immutable).
- `GET /healthz` → `{ ok: true }` (no auth).
- Signed links: `GET /api/t/:token`, `POST /api/t/:token/action` (see `api.ts`; tokens from `src/server/tokens.ts`, valid 72 h,
  only the actions listed in the token, only for that item and member). No session needed.
- WeChat callback (no session, no CSRF header): `GET /wechat/mp` verifies `signature = sha1(sort([WECHAT_TOKEN, timestamp,
  nonce]).join(''))` and echoes `echostr`; `POST /wechat/mp` (XML) — see §7.
- Unknown query parameters (WeChat adds `?from=singlemessage…`) must be tolerated everywhere.

## 6. Web app (PWA, Simplified Chinese UI)

Screens (**path routes** — hash routes break iOS push deep links): `/` 对话 (chat), `/board` 看板, `/item/:id` 事项,
`/weekly` 本周, `/settings` 设置, `/join` 加入, `/t/:token` (signed link view, works without a session — used from WeChat). Bottom tab bar: 对话 · 看板 · 设置. Mobile-first (360–430 px wide), safe-area insets, large touch targets,
system Chinese font stack, light + dark mode.

- **对话**: chronological utterances (mine right, others' left with avatar), each with the assistant reply and a compact
  "改动" card listing `changes[].summary` lines, each tappable to the item, plus 撤销 (undo) on my own utterances.
  Clarifications render option chips; tapping sends `{ source: 'clarification', replyToUtteranceId }`.
  Input bar: text field (keyboard dictation works) + send + a big hold-to-talk mic button (press and hold to record,
  release to send, slide up to cancel, max 60 s, shows a timer). Hide the mic button if `sttEnabled` is false.
  Optimistic "处理中…" bubble while waiting.
- **看板**: sections for the signed-in member — 等我回复 (pending requests to me, with 接受/做不了 buttons), 今天 / 已过期,
  我的待办, 我在等别人 (requests I sent and items owned by others that I created), 进行中, 想法, 本周完成. Each item card shows
  title, owner avatar, due label (`formatInstantZh` style), status pill. Pull-to-refresh not required; live updates via SSE.
- **事项**: title, status, owner, requester, due, details, notes, history (events), buttons: 完成, 推迟 (今晚/明天/周末/下周),
  接受/做不了 (if pending and mine), 编辑 (title/owner/due/details), 加备注, 分享到微信 (Web Share API: text + link to the item;
  fall back to copying the link).
- **本周**: what got done, what's stuck, ideas to decide, next week's dated items.
- **设置**: name/aliases, quiet hours, digest time, notification setup (see §7), "发送测试通知", family members list and
  "邀请家人" (adults: create member → show invite link + QR-free copy button), install instructions for iPhone (Safari →
  分享 → 添加到主屏幕) and Android (Chrome 菜单 → 安装应用), logout.
- **加入**: reads `#token=` from the URL, POSTs join, then goes to `/` and prompts to install + enable notifications.
- **/t/:token**: minimal item card from `GET /api/t/:token` with big 接受 / 做不了 / 完成 buttons as allowed; works inside
  WeChat's in-app browser. Shows a hint: 点右上角 ··· → 在浏览器打开 to install the app.
- Detect WeChat's in-app browser (`MicroMessenger` in the UA) everywhere and show a banner: 点右上角 ··· → 在浏览器打开，以安装/开启通知.
- Notifications: register the service worker, `syncSubscription()` on every launch (iOS never fires pushsubscriptionchange),
  ask for permission only from a button tap; on iOS explain that the app must be added to the home screen first
  (iOS 16.4+). Android must be installed too (Chrome auto-revokes for un-installed low-engagement sites). Listen for
  `postMessage({type:'navigate', url})` from the service worker and route to it.

## 7. Notification channels and speech-to-text

Research briefs: `docs/research/pwa.md`, `wechat.md`, `stt.md`, `critique.md` (decisions below win where they differ).

**Web push (primary, `webpush` channel)** — `web-push` 3.6.7 with VAPID (`npm run family -- vapid` prints keys).
- Payload is `PushPayload` in `src/shared/types.ts` (Declarative Web Push, `web_push: 8030`, absolute `navigate` =
  `${PUBLIC_URL}${n.url}${?|&}src=push`, `lang: 'zh-CN'`, `tag: item-<id>`, buttons in `notification.data.actions`; ≤ 3 KB).
- Options: `TTL` (request_*/due/explicit 3600, digest/weekly 12 h, others 6 h), `urgency: 'high'` for request_*, due,
  explicit, assigned; `topic` = `i<itemId>` sanitized ≤ 32 chars.
- 404/410 → delete the subscription (permanent); 429/5xx → retry; 400/403/413 → log, count failure. Update
  `last_success_at` / `failure_count`. Send to every subscription of the member.
- Service worker (`src/web/sw.ts`): precache via workbox; `push` handler always shows a notification (Chrome requires it)
  with up to `Notification.maxActions` buttons from `data.actions`; `notificationclick` with an action → `POST
  /api/notifications/:id/action` (cookie session, header `X-Family-Share: 1`), then notify open windows; on failure or a
  body tap → focus an existing window and `postMessage({type:'navigate', url})`, else `openWindow(url)`. Badge via
  `setAppBadge` when `app_badge` is present.

**WeChat (`wechat` channel) — 公众号接口测试号 template messages.**
- Access token: `GET https://api.weixin.qq.com/cgi-bin/token?grant_type=client_credential&appid=…&secret=…` (cache, refresh
  10 min before `expires_in`; on errcode 40001/42001 refresh once and retry).
- Send: `POST https://api.weixin.qq.com/cgi-bin/message/template/send?access_token=…` body
  `{touser: openid, template_id, url, client_msg_id: <notification id>, data: {task:{value}, from:{value}, when:{value}, note:{value}}}`.
  Values: strip CR/LF, control chars and emoji; ≤ 20 chars each (truncate with …). `url` = `${PUBLIC_URL}/t/<link token>`
  (72 h, allowed actions per kind: request_new/followup → accept, decline, view; due/explicit/assigned/stale → done, view;
  others → view). Errors: 43004/40003 (not following / bad openid) → permanent, mark the member's wechat channel unbound;
  45009/-1 → retry; 47003 → log the payload (formatting bug).
- Routing per member (`member_channels` row `wechat`, config `{ openid, mode }`): `fallback` (default) = send on WeChat
  only if the member has no healthy web push (no subscription, or none succeeded in the last 7 days, or every push
  attempt for this notification failed); `both`; `only` (skip web push); `off`.
- Binding: settings → "绑定微信" → `POST /api/wechat/bind-code` (6 digits, 30 min) → the member follows the test account
  and sends `绑定 123456` → callback stores the openid and replies passively "绑定成功，以后提醒会发到这里". 
- Inbound callback `POST /wechat/mp`: verify signature; parse XML (fast-xml-parser); dedupe on `MsgId` (table
  `wechat_inbound`); always answer within 5 s (empty string = ack). `subscribe` event → reply with binding instructions.
  `text` from a bound openid → passive reply `收到，处理中…`, then interpret asynchronously (source `wechat`) and send the
  result back as a template message (task = reply, truncated; when = now; note = first change). Text from an unbound
  openid → reply with binding instructions. `voice` → reply "语音请在 App 里说，或发文字" (voice via media/get is v0.5).
- If WeChat isn't configured, the channel is not listed and settings explain how to set it up.

**Speech-to-text** (`src/server/stt/`)
- Normalize every upload with ffmpeg when available: `ffmpeg -nostdin -hide_banner -loglevel error -i in.<ext> -vn -ac 1
  -ar 16000 -c:a pcm_s16le -f wav out.wav` (write the upload to a temp file first; iOS MP4 from stdin can fail). If ffmpeg
  is missing, send the original for openai (it accepts webm/mp4/m4a) and refuse for qwen.
- `openai`: `POST ${baseUrl ?? 'https://api.openai.com'}/v1/audio/transcriptions`, `Authorization: Bearer`, multipart:
  `file`, `model` (default `gpt-transcribe`), `languages[]` (member hints; default `zh`,`en`), `keywords[]` (member names
  + aliases + up to 40 open item titles; strip `<`, `>`, CR, LF; never send `language` together with `languages`),
  `prompt` (short Simplified-Chinese scene description), `response_format=json`. Response `{ text, languages? }`.
  15 s timeout, one retry on 5xx/network.
- `qwen`: Alibaba Model Studio intl, `POST ${baseUrl}/chat/completions` (OpenAI-compatible; baseUrl like
  `https://dashscope-intl.aliyuncs.com/compatible-mode/v1`), model `qwen3-asr-flash`, message content
  `[{type:'input_audio', input_audio:{data:'data:audio/wav;base64,…'}}]`, optional system context; ≤ 10 MB base64.
  See `docs/research/stt.md` for the exact shape and verify against the docs it cites.
- Primary then fallback; `SttError` when both fail. OpenCC t2s on the text for zh-CN members (`rawText` keeps the original).
- Keep the audio file (`DATA_DIR/audio`) so a failed transcription can be retried (`POST /api/utterances/voice` with
  `retryAudio=<utteranceId>` is not needed in v0 — the UI shows the error and the keyboard-dictation hint).
- Browser recording: choose the MediaRecorder type at runtime — Apple devices `audio/mp4` first, others
  `audio/webm;codecs=opus` first; no timeslice; send the recorder's actual `mimeType`. Keep the mic stream while the app is
  visible; release it when hidden or after 60 s idle. Max 60 s.

## 8. Tests (must exist and pass)

- domain: create/update/complete/drop, request lifecycle incl. forbidden responder, notification rows per §3 (kinds,
  fire times, dedupe, cancellation), undo restores before-state and cancels scheduled rows, kind/status rules.
- scheduler: quiet-hour deferral, relevance skip, retry/backoff, digest/stale/weekly generation idempotent across ticks,
  using FixedClock and a fake channel.
- interpreter: with a fake Anthropic client returning scripted tool_use blocks: tool → domain mapping, is_error on invalid
  input, ask_clarification ends the turn, loop cap, refusal / API error → status error, context block contents.
- http: join flow + cookie, auth required, CSRF header, item routes, notification action ownership, voice route with a fake
  SttProvider.
- web: `npm run build:web` succeeds and `npm run typecheck` is clean.
