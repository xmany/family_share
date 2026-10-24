# Research brief: wechat (2026-10-21)

## Recommendation

For v0, make PWA Web Push the main channel and use a WeChat Official Account sandbox test account (公众号接口测试号) as the one WeChat outbound channel. It is free and needs no ICP filing, business license or ID. It can push template messages at any time, up to 100k/day, to followers (Tencent says the follower cap is 20, which is plenty for a family). The cost is a short card: no first/remark lines, no line breaks, each field folds after about 20 characters, plus one tappable link. Use it for short reminders, "she asked you to…" requests, and digest teasers that link back to the PWA. The same test account can also receive text and voice later. Download the voice file and run your own Mandarin speech-to-text, because the Recognition field is unreliable and Tencent said in 2023 it plans to remove it. Treat WeChat's official ClawBot (iLink, launched 2026-03-22) as an optional second channel to test first, not as the main one. It reportedly allows only about 10 bot messages per user message and expires after 24h without one, and accounts registered with overseas phone numbers have been told "此账号暂时不支持该功能". Skip PushPlus (needs a Chinese/HK/MO/TW ID and paid real-name check), Server酱 (5 msgs/day free, routed through a third party), WxPusher (now mostly its own app plus ClawBot), WeCom (trusted-IP/ICP hurdles, unclear whether WeChat-plugin delivery still works) and personal-account bots (ban risk).

# Reaching the family inside WeChat (late 2026, overseas individual developer, no ICP)

Assumptions: server and domain are outside mainland China, no ICP filing, no business license, possibly no mainland ID. The family's WeChat accounts may be registered with **+86 numbers or with overseas numbers**. This matters a lot for ClawBot (see 1.2), so check it on day 1.

---
## 0. TL;DR

| Need | v0 choice | Why |
|---|---|---|
| Primary notifications | **Web Push from the installed PWA** (iOS 16.4+ added to Home Screen from Safari; Android Chrome) | No WeChat limits, full content, works with APNs/FCM outside China |
| WeChat outbound | **Official Account sandbox test account → template messages** | Free, no ICP, license or ID. Proactive at any time. 100k/day. Tappable link. |
| WeChat inbound (v0.5/v1) | **The same test account**: receive-URL callback (text and voice) | 5-s passive reply plus async template follow-up. Voice by downloading media and running your own speech-to-text. |
| Optional experiment | **WeChat ClawBot (iLink)** per family member | Natural chat bubble, inbound voice comes with `voice_item.text` transcript. Limited to about 10 msgs per 24h window and has region gating. |
| Don't | PushPlus, Server酱, WxPusher-as-WeChat, WeCom, Wechaty/iPad/pad protocols, Mini Program, personal 订阅号 | See the matrix |

---
## 1. Outbound options

### 1.1 Official Account sandbox test account (公众号接口测试号) — RECOMMENDED WeChat channel
- **URL:** https://mp.weixin.qq.com/debug/cgi-bin/sandbox?t=sandbox/login. Log in by scanning with WeChat. The page is live (footer © 2012-2026). The official docs still say you can get a test account just by scanning the QR code ("通过手机微信扫描二维码即可获得测试号"). Each WeChat account owns one test account.
- **Viability overseas:** no ICP, license or ID is required to create it. The server URL can be any http(80)/https(443) endpoint. *Not verified: whether an overseas-registered WeChat account can create one, and whether the login asks for SMS verification. The login page has a phone/verification-code field.*
- **Followers:** the page says "用户列表（最多100个）". However, WeChat community ops replied on 2023-12-28: "平台侧调整测试号的关注上限为20". **Plan for 20.**
- **Template messages:** the sandbox permission table lists 模板消息（业务通知）at a 100,000/day cap. You define free-form test templates yourself, with no review.
- **2023 rule change (applied 2023-05-04, test accounts also affected):** the first-line and remark fields are removed, custom colors and emoji are removed, values cannot contain line breaks, and each middle field is limited to about 20 characters (longer text gets folded). For test templates, use `标签：{{key.DATA}}` lines; a colon is required or the value will not substitute. Category templates have typed fields (`thing` 1-20 chars, `character_string` ≤32, `time`, …), and control characters or newlines return 47003.
- **Link:** the `url` field makes the card tappable. It opens in WeChat's built-in browser (see section 3). The official doc says "overseas accounts cannot use jump links", but that refers to official accounts registered by overseas entities, not to test accounts.
- **Multi-recipient:** one API call per openid. Loop over the family.
- **Privacy:** content passes through Tencent only. There is no third-party relay.
- **Reliability and ToS:** this is a first-party Tencent tool meant for testing. Ban risk is low at family scale. Tencent can change limits silently (the 100→20 cap change was one example). There is no SLA.
- **Display:** the card shows up in the chat list as an official-account conversation with a notification. *Not verified: the display name and avatar of a test account. You probably cannot customize them.*

### 1.2 WeChat ClawBot (微信ClawBot / iLink protocol) — NEW in 2026, optional
- **What it is:** an official WeChat plugin launched on 2026-03-22. Path: 我→设置→插件→ClawBot, on iOS 8.0.70+ / Android 8.0.69+. It connects a user's personal WeChat to a bot backend over HTTP/JSON at `ilinkai.weixin.qq.com`. The reference client is Tencent/openclaw-weixin (MIT license, v2.4.10 released 2026-10-10). Many people implement the protocol directly without OpenClaw.
- **One ClawBot per WeChat account. It only talks to its owner** and does not support groups. For a family, **each member scans a QR code generated by our server**, which gives N bot sessions.
- **Proactive limits** (from PushPlus's docs, WxPusher's docs updated 2026-10-10, and GitHub issue #202 from 2026-06-15; none of these is an official spec):
  - The user must send the bot a message once after binding.
  - **About 10 bot messages are allowed per user-initiated message.**
  - **The context_token expires after 24h without a user message.**
  - WxPusher puts it as "激活后24小时内最多接收10条推送；用尽后需用户向ClawBot回复任意内容再次激活".
  - Issue #202 asks for 30-50 messages. A Tencent person said on 2026-06-18 they had "pushed product to reassess". There has been no change since.
- **Region gating:** GitHub issue Tencent/openclaw-weixin#122, opened 2026-05-06 and still open, reports "此账号暂时不支持该功能" for an account registered with an overseas phone number, and others confirmed it through September. Tencent Cloud's guide says "当前海外仅部分地域支持…目前香港地域已支持". **If the parents' accounts are not +86, assume ClawBot does not work until a real scan proves otherwise.**
- **Pros:** looks like a normal chat bubble. Full text with partial Markdown. Inbound voice carries a transcript in `voice_item.text`. There is no third party in the path.
- **Cons:** the 10-msg/24h window breaks a deterministic scheduler. If a parent does not message for a day, reminders silently stop. The protocol is not publicly documented and is in gray-scale rollout ("腾讯保留随时调整、限制或终止服务的权利"). The terms (《微信ClawBot功能使用条款》) frame it as connecting to "自身部署或使用的第三方AI服务", which fits a self-hosted family assistant. *I could not read the terms in full.*

### 1.3 WxPusher
- Free (docs updated 2026-10-10). The company is 四川思明今创科技有限公司. The docs say "早期以微信公众号为主要触达通道，当前主推独立全平台客户端". WeChat delivery is now through **ClawBot as a supplementary channel**, with the same 10/24h limit and send-only (no inbound).
- API: `POST https://wxpusher.zjiecode.com/api/send/message` with body `{appToken:"AT_…", content (≤40,000 chars / 65,535 UTF-8 bytes), summary (≤100), contentType 1 text / 2 HTML / 3 Markdown, uids[] (≤2000), topicIds[] (≤5), url (≤1000), verifyPayType}`. Success is `code` 1000. The rate limit is about 20 calls per 10 s. Data is kept 7 days.
- WxPusher sees all content and hosts the detail page. For a family it adds nothing beyond doing ClawBot ourselves, except its own app, and we already have the PWA.

### 1.4 PushPlus (推送加)
- `POST http://www.pushplus.plus/send` with `{token,title,content,template:"html|txt|markdown…",channel:"wechat|clawbot|cp|webhook|mail|app…",topic,to,callbackUrl,timestamp}`. `to` takes friend tokens: up to 10 for real-name users, 100 for members.
- **Real-name has been mandatory since 2024-08-01.** Without it the API returns error 905. You must enter name, ID number, and a phone number registered to the same person. It is a **paid, non-refundable check, or free with one month of membership (10元/月)**. Only HK/MO/TW residence permits (810000/820000/830000) are accepted. Other overseas users must contact the developer for manual handling.
- Limits:

  | | Real-name users | Members |
  |---|---|---|
  | Requests per day | 200 | 2,000 |
  | Request rate | 5/min | 5 per 10 s |
  | Same content | 3/h | 3/h |
  | Title / content length | 100 / 20,000 chars | 200 / 100,000 chars |

  Above 2,000 requests per day, the account is restricted for 7 days.
- On the WeChat 公众号 channel, **real-name users see only the title**. The full text is on PushPlus's detail page, so the third party sees everything. Its ClawBot channel has the same 10/24h rules.
- **Verdict:** not viable without a Chinese/HK/MO/TW ID, and the privacy is poor.

### 1.5 Server酱 Turbo (ServerChan)
- `POST https://sctapi.ftqq.com/{SendKey}.send` with `title` (no newlines, about 32 chars) and `desp` (Markdown).
- **Free tier: 5 msgs/day.** Members get 1,000/day at 8元/月, 39元/年 or 180元/5年. The limit is 50 msgs/min. Messages are kept 1 day (free) or 3 days (member).
- Each SendKey sends only to its owner, so each family member needs an account. Content goes through the third party.
- It can also proxy *your own* test account, which is pointless if you call the test account directly.
- **Verdict:** no.

### 1.6 WeCom (企业微信) self-built app + WeChat plugin (微信插件)
- API:
  - `GET https://qyapi.weixin.qq.com/cgi-bin/gettoken?corpid=…&corpsecret=…`
  - `POST https://qyapi.weixin.qq.com/cgi-bin/message/send?access_token=…` with `{touser:"u1|u2", msgtype:"text", agentid:1000002, text:{content}, enable_duplicate_check, duplicate_check_interval}`
  - Content is limited to 2048 bytes. Per app, each member can get at most 30 messages/min and 1,000/h.
- **Hurdles:**
  - Apps created since mid-2022 need **企业可信IP**. To set that, you first need either a trusted domain or a verified "接收消息服务器URL". The trusted domain must be ICP-filed (for more than 10 days) and match the enterprise's subject.
  - Community reports say unverified enterprises can still use the receive-URL route to unlock the trusted IP, but I could not find official 2025-2026 confirmation.
  - The README of the open-source asundust/wechat-work-push project warns that new messages may no longer reach personal WeChat ("目前貌似不再支持在微信中接收新消息…只能在企业微信APP收消息").
  - If the app is set to "在微工作台中始终进入主页", WeChat-plugin text is truncated to 20 bytes.
  - Each family member must be added as an enterprise member and follow the plugin (invite QR codes last 7 days).
- **Verdict:** too fragile and too much setup for v0.

### 1.7 WeCom group robot webhook
- `POST https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=KEY` with text (≤2048 bytes) or `markdown` / `markdown_v2` (≤4096 bytes). Limited to 20 msgs/min per robot.
- Messages land in **WeCom groups**, and reports say personal-WeChat members of a group cannot see robot messages.
- **Verdict:** not a WeChat channel for this family.

### 1.8 Unrealistic or high-risk
- **Personal-account bots** (Wechaty with pad/iPad/Mac protocols, hooking): violate WeChat ToS, and the account can be banned at any time ("随时可能被封号"). They also usually need paid third-party tokens. **Don't use them.** ClawBot is the sanctioned replacement.
- **Mini Program:** a personal registration needs a Chinese ID. New Mini Programs have had to complete ICP filing (小程序备案) before launch since 2023-09-01, and existing unfiled ones were removed after 2024-03-31. Not possible for an overseas individual.
- **Your own 订阅号 or 服务号:**
  - A personal 订阅号 needs a mainland ID and has no template or customer-service API.
  - A 服务号 needs an entity, and template messages need certification.
  - Overseas-entity accounts need business documents, and their template links cannot jump.
  - *Not verified for 2026 pricing.*

---
## 2. Inbound capture from WeChat

### 2.1 Test-account receive URL (viable)
- **Configure:** in the sandbox page, set 接口配置信息 to a URL plus a Token. WeChat sends `GET ?signature&timestamp&nonce&echostr`. Verify that `sha1(sort([token,timestamp,nonce]).join(''))` equals `signature`, then echo back `echostr`.
- **Messages:** arrive as `POST` with an XML body:
  - Text: `<ToUserName>gh_xxx</ToUserName><FromUserName>OPENID</FromUserName><CreateTime>…</CreateTime><MsgType>text</MsgType><Content>…</Content><MsgId>…</MsgId>`
  - Voice: `MsgType=voice` with `MediaId`, `Format` (amr/speex), `MediaId16K`, `MsgId`
  - Events: `MsgType=event`, `Event=subscribe` / `unsubscribe` / `SCAN`, with `EventKey`
- **5-second rule:** WeChat waits 5 s, then retries up to 3 times. Deduplicate on `MsgId`. Reply with an empty string (or `success`) to ack with no message. Alternatively, reply passively within 5 s with XML `<xml><ToUserName>OPENID</ToUserName><FromUserName>gh_xxx</FromUserName><CreateTime>ts</CreateTime><MsgType>text</MsgType><Content>收到，处理中…</Content></xml>`.
- **Async result:** run the LLM after the ack. Send the result as a **template message** (not limited by any window) or as a customer-service message.
- **Customer-service messages:** `POST https://api.weixin.qq.com/cgi-bin/message/custom/send?access_token=…` with `{"touser":OPENID,"msgtype":"text","text":{"content":"已添加：取快递 <a href=\"https://app/x\">查看</a>"}}`. Text supports `<a href>`.
  - The current official rule is that after a user message you can send **5 messages within 48 h**.
  - After a follow, menu click or QR scan, you can send 3 messages within 1 minute.
  - *Whether these quotas also apply to test accounts is not verified.*
- **Voice:**
  - The `Recognition` field (from 接收语音识别结果) is unreliable: reports say it is empty for clips over about 10 s. In 2023 WeChat community ops said speech recognition "后续计划会下线" and advised downloading the audio and converting it yourself.
  - So fetch the audio with `GET https://api.weixin.qq.com/cgi-bin/media/get?access_token=…&media_id=MEDIA_ID` (AMR at 8 kHz; temporary media lasts about 3 days). Use `MediaId16K` if present.
  - Transcode with ffmpeg and run a Mandarin/English speech-to-text model.

### 2.2 ClawBot inbound (viable only if region and version allow)
- Long-poll `getupdates`. Text arrives as `item_list[].type=1` with `text_item.text`. Voice arrives as `type=3`, and `voice_item.text` is the "语音转文字内容". If there is no transcript, download the SILK audio from the CDN (AES-128-ECB) and decode it at 24 kHz.
- The reply must carry that message's `context_token`.
- Only one poller is allowed per bot.

### 2.3 Not realistic
Personal-account bots (ban risk), Mini Programs (ICP), and WeCom group robots (send-only).

---
## 3. Opening PWA links inside WeChat's in-app browser
- **Possible outcomes for an overseas, non-ICP domain:**
  - It opens normally.
  - A **blue interstitial** says "非微信官方网页，请确认是否继续访问" and the user taps 继续访问.
  - A **white page** says "如需浏览，请长按网址复制后使用浏览器访问".
  - A **red block** says "已停止访问该网页". This usually happens after reports, for scam-like patterns, or for cheap TLDs like .xyz/.top.
- **The lists differ for China and international accounts:** Citizen Lab found WeChat uses different URL blacklists and whitelists for mainland-registered and international accounts.
- **Escape hatch:** the "···" menu at the top right offers "在浏览器打开" (the wording varies by OS and version). It is not available on the red page, where the user has to copy the link.
- **Tips:**
  1. Make the WeChat message **self-contained** (what, who, when) so the link is optional.
  2. Use a stable .com/.app domain with valid HTTPS, no URL shorteners and no redirect chains.
  3. Detect `MicroMessenger` in the UA and show a banner: "点右上角 ··· → 在浏览器打开，以安装/开启通知".
  4. **Never rely on the WeChat webview for service workers, Web Push, Add-to-Home-Screen, or persistent login.** iOS WeChat is a WKWebView with its own storage. iOS also does not route links into installed PWAs, so links always open Safari, not the PWA.
  5. Deep links should use an opaque, short-lived, signed token (for example `/t/abc123?k=<hmac>`) that allows only "view / mark done" without a full login. Put no personal data in query strings.
  6. Hold-to-talk microphone in the WeChat webview is unreliable. Send people to the PWA, or let them send a WeChat voice message to the test account instead.
  7. Add text commands on the test account so the family can act without opening the link at all, e.g. reply "完成 3" or "1".

---
## 4. Recommended v0 design

```ts
interface OutboundMsg {
  kind: 'reminder'|'request'|'nudge'|'digest';
  title: string;                         // e.g. 家庭任务提醒
  fields: {key: string; value: string}[]; // ≤4 short fields
  url?: string;                          // signed deep link
  dedupeKey: string;                     // e.g. task42:remind:2026-10-21T18:00
}
interface NotificationChannel {
  id: 'webpush'|'wechat_mp_test'|'wechat_clawbot';
  isReady(memberId: string): Promise<{ok: boolean; reason?: string}>; // subscribed? token fresh?
  send(memberId: string, msg: OutboundMsg): Promise<{ok: boolean; providerId?: string; retryable?: boolean; error?: string}>;
}
```
- **Routing:** a per-member preference order, e.g. `['webpush','wechat_mp_test']`. Send to every channel the member enabled, or to the second one only if the first fails, depending on the member's setting. ClawBot is used only when `isReady` reports a fresh window (fewer than 24h since the user's last message and fewer than 10 sends counted locally). Otherwise fall back to the template.
- **Formatting for wechat_mp_test:**
  - Strip `\r\n`, control characters and emoji from values.
  - Truncate each value to 20 chars with "…".
  - Digest becomes a teaser, e.g. `今日待办：5项（3项今天到期）`, plus a link.

### 4.1 Test-account implementation (exact)
1. **Create the account:** a parent scans the sandbox login and records the `appID` and `appsecret`.
2. **Server config:** set 接口配置信息 URL to `https://<domain>/wechat/mp` and a random Token. Implement the GET signature check and the POST XML handler. The handler must answer within 5 s and deduplicate by MsgId.
3. **Create a test template** (新增测试模板):
   - Title: 家庭任务提醒
   - Content:
     ```
     事项：{{task.DATA}}
     来自：{{from.DATA}}
     时间：{{when.DATA}}
     备注：{{note.DATA}}
     ```
   - Record the `template_id`. Optionally add separate templates for 请求 and 每日摘要.
4. **Followers:** each member scans 测试号二维码. If scanning on the same phone, screenshot the code and use WeChat 扫一扫 → 相册.
5. **Binding openid to a member:**
   - Option A (robust): the PWA shows a one-time code. The member sends `绑定 482913` to the account. On the text event, map `FromUserName` to the member and passively reply "绑定成功".
   - Option B: a parametric QR. `POST https://api.weixin.qq.com/cgi-bin/qrcode/create?access_token=…` with body `{"expire_seconds":2592000,"action_name":"QR_STR_SCENE","action_info":{"scene":{"scene_str":"bind_<nonce>"}}}`. Show `https://mp.weixin.qq.com/cgi-bin/showqrcode?ticket=<urlencoded ticket>`. The event comes back as `subscribe` with `EventKey=qrscene_bind_<nonce>`, or `SCAN` with `EventKey=bind_<nonce>`. *Not verified: whether test accounts have this permission.*
6. **Access token:** `GET https://api.weixin.qq.com/cgi-bin/token?grant_type=client_credential&appid=APPID&secret=SECRET` returns `{access_token, expires_in:7200}`. Alternatively use `POST https://api.weixin.qq.com/cgi-bin/stable_token` with `{"grant_type":"client_credential","appid":"…","secret":"…","force_refresh":false}`. Cache one token per process and refresh about 10 minutes early. On 40001 or 42001, refresh once and retry.
7. **Send:** `POST https://api.weixin.qq.com/cgi-bin/message/template/send?access_token=TOKEN`
```json
{"touser":"OPENID","template_id":"TEMPLATE_ID","url":"https://app.example.com/t/42?k=…",
 "client_msg_id":"task42-remind-202610211800",
 "data":{"task":{"value":"取快递"},"from":{"value":"妈妈"},"when":{"value":"今天18:00"},"note":{"value":"丰巢柜3号"}}}
```
   - The response is `{"errcode":0,"errmsg":"ok","msgid":…}`.
   - `client_msg_id` deduplicates the same openid within 10 minutes.
   - Handle these errors:
     - 40003: invalid openid
     - 43004: recipient not following (needs follow). Mark the channel broken.
     - 40037: bad template_id
     - 47003: field format, e.g. a newline in a value
     - 45009: API frequency limit
     - 43116: template restricted
     - -1: system error, retry with backoff
   - Optionally listen for the `TEMPLATESENDJOBFINISH` event (`Status=success`, `failed:user block`, or `failed: system failed`).
8. **Inbound pipeline:**
   - Text: `Content` goes to the LLM interpreter, then task operations, then a confirmation by template (or customer-service message within its quota).
   - Voice: `media/get` → ffmpeg → speech-to-text → same pipeline.

### 4.2 ClawBot implementation (optional; mirrors Tencent/openclaw-weixin v2.4.10 source)
- **Headers on every POST:**
  - `Content-Type: application/json`
  - `AuthorizationType: ilink_bot_token`
  - `Authorization: Bearer <bot_token>` (after login)
  - `X-WECHAT-UIN: base64(String(randomUint32))`, new value per request
  - `iLink-App-Id: bot`
  - `iLink-App-ClientVersion: (major<<16)|(minor<<8)|patch`
- **Body:** always include `"base_info":{"channel_version":"2.4.10","bot_agent":"FamilyShare/0.1"}`.
- **Login:**
  - `POST https://ilinkai.weixin.qq.com/ilink/bot/get_bot_qrcode?bot_type=3` with body `{"local_token_list":[]}` returns `{qrcode, qrcode_img_content}`. Render the QR from `qrcode_img_content` and show it on another screen.
  - Long-poll `GET …/ilink/bot/get_qrcode_status?qrcode=…` (about 35 s). Statuses: `wait`, `scaned`, `confirmed`, `expired`, `scaned_but_redirect` (comes with `redirect_host`), `need_verifycode`, `verify_code_blocked`, `binded_redirect`.
  - `confirmed` returns `bot_token`, `ilink_bot_id`, `baseurl` and `ilink_user_id`. Store them per member.
- **Receive:**
  - `POST {baseurl}/ilink/bot/getupdates` with `{"get_updates_buf":"<cursor or ''>","base_info":{…}}`. The response is `{ret, msgs[], get_updates_buf, longpolling_timeout_ms≈35000}`.
  - Persist the cursor. Each msg has `from_user_id:"…@im.wechat"`, `message_type` (1 = user, 2 = bot), `context_token` and `item_list`.
  - Store the latest `context_token` and timestamp per member. Reset the local send counter to 0.
- **Send:** `POST {baseurl}/ilink/bot/sendmessage`
```json
{"msg":{"from_user_id":"","to_user_id":"xxx@im.wechat","client_id":"familyshare:1761030000000-a1b2c3d4",
 "message_type":2,"message_state":2,"context_token":"<latest>",
 "item_list":[{"type":1,"text_item":{"text":"妈妈请你今天18:00前取快递 https://app.example.com/t/42"}}]},
 "base_info":{"channel_version":"2.4.10","bot_agent":"FamilyShare/0.1"}}
```
   - The response is `{}` or `{ret, errmsg, message_id}`. A non-zero `ret` means failure.
   - `from_user_id` must be `""` and `client_id` must be unique. If either is wrong, the message is dropped silently.
- **Errors:** `ret` or `errcode` of `-14` means a stale bot token. Stop and ask for a re-scan. The official plugin pauses that account for 1 h.
- **Keep-alive UX:** count sends per window. When about 8 of 10 are used, or 20h have passed since the last user message, append "回复任意内容以继续接收提醒". When the window is closed, fall back to the template channel.

### 4.3 Web Push (primary) notes
Standard VAPID Web Push. On iOS it works only for a Home-Screen web app (iOS 16.4+, installed from Safari), and permission must be requested from a user tap. Android Chrome works directly. Both work from an overseas server. Prompt for permission only inside the installed PWA, never in the WeChat webview.

---
## 5. Risks and mitigations
- **Test-account policy drift** (cap 100→20 in 2023, template restrictions in 2023): keep Web Push primary and make the channel pluggable. Monitor for 43004/45009 errors.
- **Test account is formally a testing tool:** keep the volume tiny and avoid marketing-like content (errcode 40249).
- **ClawBot is gray-scale and undocumented:** feature-flag it and test region and version per member before offering it.
- **In-app browser blocks:** keep messages self-contained, support WeChat-side text commands, and give "open in browser" instructions.
- **Privacy:** all WeChat channels pass through Tencent. Keep sensitive details (health, money, passwords) out of WeChat payloads, and send only a title plus a link that needs a token.

## 6. Day-1 validation checklist (before coding)
1. Each parent opens 我→设置→插件 and checks whether ClawBot exists and binds. This settles the region question.
2. The developer creates the test account and confirms the 体验接口权限表 includes template messages, customer-service, media and parametric-QR permissions. Also check whether an IP whitelist is required.
3. Both parents follow it. Confirm both iPhone and Android receive the template notification and see the fields as expected.
4. Tap the link on both phones. Note whether the domain gets the blue warning, the white page, the red block or nothing. Test "··· → open in browser".
5. Send a 30-second Mandarin voice message to the test account. Confirm `media/get` returns AMR, and check whether `Recognition` is empty.

## Unverified

- Whether a WeChat account registered with an overseas phone number can create the sandbox test account, and whether the sandbox login asks for SMS phone verification (the login page has a phone/verification-code field).
- The current test-account follower cap. WeChat community ops said 20 on 2023-12-28; the sandbox page text still says 100.
- The test account's exact permission table in 2026 (customer-service messages, parametric QR codes, media/get, voice recognition), and whether test-account access_token calls need an IP whitelist.
- Whether the customer-service quota (5 messages per 48h after a user message; 3 per minute after follow, menu click or scan) applies to test accounts. It is documented for certified service accounts.
- The current state of the voice Recognition field. A 2023 community reply said it is planned to go offline; the docs page I fetched no longer lists it.
- How a test account appears in the chat list (display name and avatar) and whether template cards from it show every field on current iOS and Android WeChat.
- Exact template field truncation on test accounts (about 20 chars, folded) is based on 2023 announcements and developer reports, not a test-account-specific official doc.
- ClawBot availability for overseas-registered WeChat accounts as of October 2026. Issue #122 is still open; Tencent Cloud says Hong Kong is supported and other regions are rolling out.
- The exact semantics of ClawBot's 10-message / 24h window (whether replies count, whether it resets per user message, which ret code means exhausted). Sources are PushPlus and WxPusher docs and GitHub issue #202, not an official spec.
- Whether iLink (ilinkai.weixin.qq.com) is reliably reachable from, or allowed for, overseas server IPs. One community note says to use a direct connection with no proxy.
- The full text of 《微信ClawBot功能使用条款》. I saw only third-party quotes.
- Whether WxPusher still delivers through its WeChat 公众号 template messages. Its 2026-10-10 docs no longer list the 公众号 as a delivery channel.
- Server酱 Turbo real-name requirements and exactly what its WeChat cards show.
- Whether PushPlus will manually verify overseas users without a CN/HK/MO/TW ID.
- WeCom: whether app messages from an unverified enterprise still reach personal WeChat through the WeChat plugin in 2026; whether the receive-message-URL route to unlock trusted IP still works without ICP; whether WeCom can be registered with an overseas phone number.
- Whether personal-WeChat members can see WeCom group-robot messages (third-party reports say no).
- How WeChat's in-app browser will treat this family's specific domain (warning, block, or nothing), the exact wording of the 'open in browser' menu, and microphone (getUserMedia) support in the WeChat webview. All need on-device testing.
- 2026 rules and prices for overseas-entity official accounts and for personal subscription accounts.

## Sources

- https://developers.weixin.qq.com/doc/offiaccount/Basic_Information/Requesting_an_API_Test_Account.html
- https://mp.weixin.qq.com/debug/cgi-bin/sandbox?t=sandbox/login
- https://developers.weixin.qq.com/community/minihome/doc/000e64bb264ca8e881d06f7d462000
- https://developers.weixin.qq.com/community/minihome/doc/0004281ab30e00bc91d02022a66c00
- https://developers.weixin.qq.com/doc/offiaccount/Message_Management/Template_Message_Interface.html
- https://developers.weixin.qq.com/doc/service/api/notify/template/api_sendtemplatemessage.html
- https://developers.weixin.qq.com/doc/service/api/customer/message/api_sendcustommessage.html
- https://developers.weixin.qq.com/doc/offiaccount/Message_Management/Receiving_standard_messages.html
- https://developers.weixin.qq.com/community/develop/doc/0006c432a40208466ae0f200666c00
- https://www.uqugu.com/blog/article/wechat-template-msg-removed-remark/
- https://finance.sina.cn/tech/2023-05-06/detail-imysvrzu2972723.d.html
- https://github.com/Tencent/openclaw-weixin
- https://raw.githubusercontent.com/Tencent/openclaw-weixin/main/CHANGELOG.md
- https://raw.githubusercontent.com/Tencent/openclaw-weixin/main/src/api/types.ts
- https://raw.githubusercontent.com/Tencent/openclaw-weixin/main/src/api/api.ts
- https://raw.githubusercontent.com/Tencent/openclaw-weixin/main/src/auth/login-qr.ts
- https://github.com/Tencent/openclaw-weixin/issues/122
- https://github.com/Tencent/openclaw-weixin/issues/202
- https://github.com/SiverKing/weixin-ClawBot-API/blob/main/weixin-openclaw-api-py-docs.md
- https://github.com/hao-ji-xing/openclaw-weixin/blob/main/weixin-bot-api.md
- https://openskillindex.com/skills/liushin-wechat-openclaw-api-ilink-usage-skill-wechat-ilink
- https://www.bytenote.net/article/wechat-ilink-bot-api
- https://openilink.com/docs/guide/background
- https://www.tencentcloud.com/techpedia/143910
- https://www.tencentcloud.com/techpedia/143911
- https://www.runoob.com/ai-agent/openclaw-weixin.html
- https://dshpluginhub.ai/zh/plugins/dsh-clawbot
- https://github.com/magictammm/clawbot-direct-push
- https://wxpusher.zjiecode.com/docs/README.md
- https://wxpusher.zjiecode.com/docs/api-reference.html
- https://wxpusher.zjiecode.com/docs/openapi.yaml
- https://wxpusher.zjiecode.com/llms.txt
- https://www.pushplus.plus/doc/
- https://www.pushplus.plus/doc/guide/api.html
- https://www.pushplus.plus/use.html
- https://www.pushplus.plus/doc/assets/clawbot.html-uFUuT3oh.js
- https://www.pushplus.plus/doc/assets/verify.html-MqS00_nx.js
- https://www.pushplus.plus/doc/assets/limit.html-DHw-Kz4b.js
- https://www.pushplus.plus/doc/assets/vip.html-CHxsXfn9.js
- https://www.pushplus.plus/doc/assets/friend.html-Ral4giQO.js
- https://sct.ftqq.com/docs/getting-started/faq/
- https://sct.ftqq.com/wechat-push/
- https://doc.sc3.ft07.com/
- https://developer.work.weixin.qq.com/document/path/90236
- https://developer.work.weixin.qq.com/document/path/91770
- https://github.com/asundust/wechat-work-push
- https://juejin.cn/post/7216635223533781051
- https://developer.aliyun.com/article/1724512
- https://citizenlab.ca/research/wechat-china-censorship-one-app-two-systems/
- https://www.secrss.com/articles/57609
