# Completeness critique (2026-10-21)

# Critique of the four family_share research briefs (Oct 2026)

**Bottom line:** v0 should use Web Push as the main channel and the WeChat test-account template as a required second channel, not an optional one. Speech-to-text is gpt-transcribe, with saved audio and a retry as the safety net. Several of the project's own contract files conflict with the briefs and need small edits before anyone builds against them.

## 1. Contradictions

**Between the briefs:**
- **Recording format:** the stt brief tries `audio/webm;codecs=opus` first, the pwa brief tries `audio/mp4` first. The stt brief also says to avoid timeslices on iOS, but the pwa code calls `rec.start(250)`. Decision: pick the type once at runtime (Apple: mp4/AAC first; Android Chrome: webm/opus first), use no timeslice, and send the recorder's real `mimeType`. ffmpeg on the server makes the choice low-risk either way.
- **Keeping the mic open:** the stt brief releases the mic after each note; the pwa brief keeps it while the app is visible. Decision: keep the stream while visible, and release it when the app is hidden or after 60 s idle. This avoids repeat prompts and clipped first syllables.
- **Hosting address:** the pwa brief says test on a Tailscale Funnel `*.ts.net` address you will keep. The wechat brief says use a stable .com/.app with no tunnels or redirects. Decision: buy your own domain before onboarding anyone. Use Tailscale only for development. Push subscriptions, Home Screen installs, cookies and permissions are all tied to the address, and a `ts.net` address may be blocked in WeChat's browser (not checked).
- **Traditional vs Simplified:** the stt brief always converts to Simplified (OpenCC t2s), and the contract in `src/server/stt/types.ts` says "Simplified Chinese text". The claude brief replies "in the same script as the utterance", which a forced conversion has already destroyed. Decision: each member's `language` setting (zh-CN / zh-TW / zh-HK) sets their script. Store and match text in Simplified, convert on display and on outbound text (Claude replies and scheduler templates). Tell Claude the speaker's preferred script in the per-turn snapshot.
- **Action buttons:** the pwa brief POSTs an HMAC token to `/api/notify/respond`. SPEC uses `POST /api/notifications/:id/action` with the session cookie. Decision: keep the cookie route for service-worker buttons. Add a signed-token route `/t/:token` only for WeChat links, which open in WeChat's browser with no session.

**Between the claude brief and the project's own files** (SPEC and contracts are meant to be authoritative):
- **Time format from the model:** SPEC says tool inputs are "ISO 8601 with offset". The brief uses local `YYYY-MM-DD` + `HH:MM` and converts on the server with `zonedToUtc`. Use the brief's approach and update SPEC. Otherwise the model has to work out the UTC offset itself, and it will get it wrong across Sydney's DST change on 2027-04-04 (I checked with Node: +11 → +10).
- **Env var names:** the brief adds a second config loader with `ANTHROPIC_MODEL` / `AI_EFFORT` defaulting to `low`. `src/server/config.ts` already has `CLAUDE_MODEL` / `CLAUDE_EFFORT` defaulting to `medium`. Use the existing config.
- **Loop cap:** 6 calls (brief) vs 8 (SPEC). Pick one in config.
- **"明天早上" default time:** 08:00 (brief) vs 08:30 (SPEC). SPEC also says to state the assumed time in the reply.
- **Assigning items to others:** the brief's executor rejects `create_item` with an owner other than the speaker (`NOT_ALLOWED`). SPEC allows it when the speaker explicitly says "记给她/assign".
- **Channel contracts:** `api.ts` still mentions `wxpusher` (`{ uid }`), which the wechat brief rejects. The wechat brief's `OutboundMsg`/`NotificationChannel` also differs from the project's existing `NotificationChannel` (`isConfigured`/`deliver`). Keep the project's interface.

## 2. Spot-checks (5 decision-critical claims)

1. **gpt-transcribe: confirmed.**
   - Official model page: $0.0045/min; supports context prompts, keyword hints and multiple language hints.
   - The guide confirms `keywords` (no `<`, `>`, CR or LF, or the whole request is rejected) and that `languages` replaces `language` (never send both).
   - New detail: `languages` accepts `zh-cn`, `zh-tw`, `zh-hk`, `cmn` and `yue`. This resolves an item the stt brief left unverified.
   - Formats: mp3/mp4/mpeg/mpga/m4a/wav/webm, 25 MB. ogg and flac are not listed in the guide.
   - The deprecations page confirms whisper-1 and all gpt-4o-*-transcribe models shut down on 2027-02-26 (announced 2026-08-26).
   - OpenAI's JS example passes `keywords`/`languages` through a `body` override, so SDK types may lag. Raw multipart `fetch` is fine.
   - Still not documented: which Chinese script it outputs.
2. **ClawBot for overseas WeChat accounts: confirmed blocked.** Issue #122 is still open, with no Tencent reply, labels or milestone; the last comment is 2026-09-25. Tencent Cloud's guide confirms only Hong Kong. Do not build it in v0.
3. **WeChat template messages: still live.** The official doc still says 10万/day with no deprecation notice; its status note reads "服务号订阅通知功能开启灰度测试，模板消息能力可正常使用". I could not verify online: the test-account follower cap (20 vs 100), whether an overseas-registered account can create the test account, or whether an IP whitelist applies. These go on the day-1 checklist.
4. **Claude API: confirmed against the bundled docs (cached 2026-10-06).**
   - Opus 5.5 costs $4/$20, cache reads $0.20; minimum cacheable prefix 512 tokens.
   - Effort defaults to `medium`. Sending `thinking` disabled or `budget_tokens` returns 400.
   - `tool_choice` `any`/`tool` returns 400, as do sampling parameters and prefill.
   - `fallbacks:"default"` must pair with the `server-side-fallback-2026-07-01` header; the array form uses `-06-01`.
   - Haiku 5.5: `"default"` is accepted but a refusal stays a refusal; a list of fallback models returns 400.
   - Not in the bundled docs, so unverified: the strict-tool limits (20 tools / 24 optional parameters / 16 unions).
5. **Declarative Web Push: still Apple-only** (iOS/iPadOS 18.4+). I found no Chrome support, so the service-worker `push` handler is required on Android. Also verified: Chrome's October 2025 auto-revoke of notification permission for low-engagement sites does not apply to installed web apps. So Android users must install the app, not just bookmark it.

Smaller checks:
- Qwen Singapore endpoint `https://{WorkspaceId}.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1` and its 10 MB / 5 min limits are confirmed. The docs list AAC/WAV/MP3 and "mainstream" formats, so the stt brief's "WAV/MP3 only" is too narrow. Price was not on the page.
- WhatsApp Cloud API test number: about 5 allowlisted recipients, a 24 h free-form window, and temporary tokens that expire in about 24 h. These come from third-party sources only, so unverified.

## 3. Missing considerations

- **Huawei and mainland-ROM phones:** no Google services means no Web Push. WeChat delivers there through Huawei's own push service, so the WeChat template channel is the realistic fallback. This is the main reason to build it in v0. ntfy on Huawei is defeated by its aggressive battery management.
- **A family member physically in mainland China:** Google's push service (FCM) is blocked, so Android Web Push fails; Apple's push still works. WeChat is again the fallback, and that member's account counts as a mainland account for WeChat's link blocking.
- **Server uptime:** a sleeping Mac means no reminders. Use a VPS or another always-on box. On restart the scheduler needs a catch-up rule: deliver late rows with a "迟到" note, or skip ones more than about 2 h late.
- **Server timezone:** `FAMILY_TIMEZONE` falls back to the server's system timezone, which is UTC on most VPSes. Make it required in production.
- **Per-member timezone:** there is only one family timezone. Quiet hours and digests will be wrong for grandparents abroad. Accept this for v0 and add `Member.timezone` later.
- **Repeating tasks** (每周二倒垃圾, 每天提醒吃药) exist in neither SPEC nor the 10 tools. Add a prompt rule now so Claude says it doesn't support repeats yet instead of silently creating one item. Add a small repeat rule (daily / weekdays / monthly-day) in v0.5.
- **Lunar dates** (农历生日, 中秋): add a lunar column to the snapshot calendar using `Intl.DateTimeFormat('zh-CN-u-ca-chinese')`. Tested on Node 24: 2026-09-25 → 八月15. Never let the model convert lunar dates itself.
- **Duplicates across scripts:** convert to Simplified before duplicate checks and `search_items`, or 買牛奶 and 买牛奶 become two items.
- **Cantonese or dialect speakers:** send `languages[]=yue` per member. Qwen3-ASR covers 22 dialects, so promote it if any grandparent needs it.
- **WeChat browser quirks:**
  - Android "在浏览器打开" goes to the default browser, often a vendor browser with no WebAPK install and no push. Tell people to set Chrome as default or paste the link into Chrome.
  - WeChat appends `?from=singlemessage…` to shared links; tolerate unknown query parameters.
  - Link-preview crawlers will GET invite URLs, so a GET must never consume an invite (SPEC's `#token` fragment plus POST to join is correct).
  - When WeChat for Mac/PC is logged in, phone notifications are muted by default. Each parent must check this setting.
  - Pin the test-account conversation so it isn't mistaken for spam.
- **iOS login trap:** SPEC's single-use invite plus the Home Screen app's separate storage. If someone joins in Safari and the cookie doesn't carry over at install, they are locked out. Allow the invite to be reused until a session exists in the installed app, or add a 6-digit pairing code.
- **Hash routes** (`#/item/:id`) in the push `navigate` / `url` fields carry the iOS start-URL deep-link bug (WebKit 263687) and an old mic-permission reset. Switch to path routes; the server already does SPA fallback.
- **Push payload contract:** `PushPayload` in `types.ts` needs to become the Declarative Web Push shape (`web_push: 8030`, absolute `navigate`, `lang`, `data.actions`) under 3 KB.
- **Push subject:** set `VAPID_SUBJECT` to a real address; the default is `mailto:admin@example.com`.
- **iOS Home Screen from other browsers:** iOS 16.4+ also allows Add to Home Screen from Chrome/Edge on iOS. Both briefs say Safari only. From memory, not re-checked.
- **WhatsApp:** your request mentions it, but none of the four briefs covers it. For v0 the share button (Web Share) already covers occasional WhatsApp and WeChat sharing. Leave any WhatsApp channel for later.

## 4. Recommended v0 stack

**Notification channels**
- **Primary: Web Push** using the existing `web-push` 3.6.7 library and the Declarative Web Push format for every device.
  - Android: the service worker shows two buttons (可以/不行, or 完成/稍后) that call the existing cookie route.
  - iOS: no buttons. A tap opens the task card at a path URL with large in-app buttons.
  - `Urgency: high` for reminders, requests and due items; always set `TTL`.
  - Re-sync the subscription on every launch and track `last_success_at`.
- **Second: WeChat test-account template messages, built in v0.**
  - Per-member mode, default "fallback": send to WeChat only if the member has no healthy push subscription (none, a permanent error, or no success in 7 days).
  - "both" is opt-in. "wechat-only" is for grandparents, Huawei phones and people in mainland China.
  - Format: 4 fields of 20 characters or less, newlines, control characters and emoji stripped, plus a `/t/:token` link (HMAC, about 72 h, limited to view / done / accept / decline).
  - Always on: in-app inbox, badge, and the daily digest.
- **Not in v0:** ClawBot, ntfy (config exists, leave it unbuilt), WxPusher, PushPlus, Server酱, WeCom, WhatsApp.

**WeChat integration**
- Day-1 checks before coding:
  - Create the test account (any family member's WeChat can own it).
  - Have both parents follow it.
  - Confirm template cards render on iPhone and Android.
  - Note whether your domain gets a warning interstitial in WeChat's browser.
  - Check whether access tokens need an IP whitelist.
- Minimal receive endpoint in v0: signature check, `subscribe` events, openid binding via a `绑定 123456` text, and dedupe on `MsgId`.
- v0.5: incoming text goes to the interpreter. Incoming voice: `media/get` → ffmpeg → speech-to-text → same pipeline. Results go back as template messages.

**Speech-to-text**
- **Primary:** `POST /v1/audio/transcriptions` with `model=gpt-transcribe`.
  - `languages[]` per member: `zh-cn` + `en` by default, `yue` for Cantonese speakers.
  - `keywords[]`: member names, aliases and open item titles, sanitized and capped at about 50.
  - `prompt`: a short scene description in Simplified Chinese.
  - Input: ffmpeg → 16 kHz mono WAV. 15 s timeout, one retry.
- **Fallback:** `qwen3-asr-flash` (Singapore) when `STT_FALLBACK_*` is configured; required if anyone speaks a dialect. Otherwise keep the audio, mark `stt_failed`, and show 重试 (retry) and the keyboard-dictation hint.
- Contract change: `TranscribeOptions` gets `languages?: string[]` and `keywords?: string[]`, and the "always Simplified" comment changes to "normalized; display per member".
- Run the week-1 bake-off on about 30 real family clips.

**Claude API: what the implementation must not get wrong**
- Model `claude-opus-5-5`, called through `client.beta.messages.create`.
- Omit `thinking`. No `temperature`/`top_p`/`top_k`, no prefill.
- Always set `output_config.effort`. Use the existing config's `medium` for v0 and evaluate `low`. If you switch the model through the env var, retune effort too: Sonnet 5.5 defaults to `high` with recalibrated levels.
- `tool_choice: {type:"auto"}` only. All tools `strict: true` with `additionalProperties: false`. Parse tool inputs with `JSON.parse` and validate with zod.
- `fallbacks: "default"` together with `betas: ["server-side-fallback-2026-07-01"]`. Never mix with the array form.
- Check `stop_reason` before reading content or running tools (refusal / max_tokens).
- Append the full `response.content` unchanged, thinking blocks included. Return all tool results in one user message. Keep conversations append-only.
- Keep the system prompt and tools frozen. Dates, the snapshot and the speaker's script preference go in the user message.
- Never ask the model to write out its reasoning; it triggers the `reasoning_extraction` refusal.
- Set only `ANTHROPIC_API_KEY`, never `ANTHROPIC_AUTH_TOKEN` as well.

**Contract and SPEC edits to make first:**
- `/Users/xman/dev/family_share/docs/SPEC.md`: time format, path routes, owner rule, morning default time, §7 channels.
- `/Users/xman/dev/family_share/src/shared/types.ts`: `PushPayload` shape and URL format.
- `/Users/xman/dev/family_share/src/shared/api.ts`: `wechat_mp_test` with `{openid}`, the `/t/:token` route.
- `/Users/xman/dev/family_share/src/server/stt/types.ts`: the `TranscribeOptions` change.
- `/Users/xman/dev/family_share/src/server/config.ts`: required `FAMILY_TIMEZONE`, `STT_FALLBACK_*`, `WECHAT_APPID/SECRET/TOKEN/TEMPLATE_IDS`, loop cap.

Sources:
- [OpenAI gpt-transcribe model page](https://developers.openai.com/api/docs/models/gpt-transcribe)
- [OpenAI speech-to-text guide](https://developers.openai.com/api/docs/guides/speech-to-text)
- [OpenAI deprecations](https://developers.openai.com/api/docs/deprecations)
- [Tencent/openclaw-weixin issue #122](https://github.com/Tencent/openclaw-weixin/issues/122)
- [Tencent Cloud ClawBot guide](https://www.tencentcloud.com/techpedia/143911)
- [WeChat template message doc](https://developers.weixin.qq.com/doc/offiaccount/Message_Management/Template_Message_Interface.html)
- [Google: Chrome automatic notification permission revocation](https://blog.google/chromium/automatic-notification-permission/)
- [Progressier: Declarative Web Push support](https://progressier.com/pwa-capabilities/declarative-web-push)
- [Alibaba Cloud Qwen speech recognition](https://www.alibabacloud.com/help/en/model-studio/qwen-speech-recognition)
- [WATI: WhatsApp test-number limits](https://www.wati.io/en/blog/test-whatsapp-message-sends-safely/)
- [Spokenly: gpt-transcribe launch](https://spokenly.app/blog/gpt-transcribe)