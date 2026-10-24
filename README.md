# 家庭同步 · family_share

自己部署的家庭协作小工具。家里人用中文说一句话或打一行字，例如「明天早上你能带孩子出去吗？我九点有个会」，AI（Claude）会把它整理成共享看板上的事项。之后由服务器上固定的规则按时发提醒、跟进请求、推送每日摘要，不靠 AI 记事。

> English summary at the end of this file.

---

## 它能做什么

- **对话**：说话（按住麦克风）或打字，AI 把这句话变成看板上的改动，回一两句话说明它做了什么。每条改动都能 **撤销**。
- **四种事项**：
  - **待办**：自己要做的事。
  - **请求**：请家人做的事，对方要点「接受」或「做不了」。
  - **想法**：没有日期的事，每周回顾时会再提出来。
  - **提醒**：到点提醒一下。
- **提醒**：快到时间前提醒，每天早上推送摘要，事情放太久会提醒一下，周日晚上发本周回顾，请求没人回复会跟进。晚上 22:00–07:30 是免打扰时间，可以在设置里改。
- **通知渠道**：
  - **App 通知**（Web Push）：主要渠道，iPhone 和安卓都能收。
  - **微信提醒**（公众号测试号模板消息）：可选。可以设成「App 通知失效时才发」或「两边都发」，也可以直接在微信里发文字给助手。
- **数据在自己手里**：所有数据都存在你自己的机器上，在 `DATA_DIR` 目录里（SQLite 数据库加语音文件）。

没有配置 AI 时，看板上的按钮照常能用（新建、完成、推迟、接受/做不了），只是说的话不会被自动整理。

---

## 需要准备

| 项目 | 说明 |
|---|---|
| **Node.js 24** | `node --version` 应显示 v24.x |
| **ffmpeg**（推荐） | 把手机录音统一转成 16 kHz WAV，iPhone 录音更稳定；用 Qwen 识别时**必须**有。macOS：`brew install ffmpeg`；Debian/Ubuntu：`sudo apt install ffmpeg` |
| **一台一直开着的机器** | 提醒是服务器发出的。Mac 睡眠时不会发任何提醒，所以推荐 Mac mini、家里一直开着的电脑或一台小 VPS |
| **Anthropic API key** | 让 AI 整理说的话。在 <https://console.anthropic.com> 创建 |
| 本机 Whisper，或 OpenAI / 阿里云百炼国际站 key（可选） | 按住说话的语音识别：本机开源 Whisper（免费，需要装了 `openai-whisper` 的 Python 和 ffmpeg），或 OpenAI `gpt-transcribe`，或 Qwen `qwen3-asr-flash`。不配也可以，手机键盘自带的语音输入照样能用 |
| Tailscale 账号（可选，推荐） | 免费给手机提供 HTTPS 地址。通知、麦克风和「添加到主屏幕」都需要 HTTPS |
| 微信（可选） | 用公众号「接口测试号」发微信提醒 |

---

## 安装和初始化

```bash
cd family_share
npm install
cp .env.example .env
```

编辑 `.env`，最重要的几项（每一项在 `.env.example` 里都有中英文说明）：

```ini
PUBLIC_URL=https://your-mac.your-tailnet.ts.net   # 手机访问的地址，见下面「HTTPS」一节
FAMILY_TIMEZONE=Australia/Sydney                 # 家庭时区，所有「明天早上」都按它理解
ANTHROPIC_API_KEY=sk-ant-...
# 语音（三选一，可选）：
# STT_PROVIDER=whisper                            # 本机 Whisper，免费；再设 WHISPER_PYTHON 和 FFMPEG_PATH
# WHISPER_PYTHON=/Users/you/.pyenv/versions/whisper_env/bin/python
# OPENAI_API_KEY=sk-...                          # 或者用 gpt-transcribe
# STT_PROVIDER=qwen
# STT_API_KEY=<百炼国际站 key>
# STT_BASE_URL=https://dashscope-intl.aliyuncs.com/compatible-mode/v1
```

> 可选项不用时请保持注释（`#`），不要留空值。像 `STT_BASE_URL=` 这样的空值会导致启动失败。

然后用命令行建家庭、生成推送密钥、添加成员：

```bash
npm run family -- init --name 我们家 --timezone Australia/Sydney
npm run family -- vapid          # 把打印出的两行 VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY 复制进 .env
npm run family -- add --name 老公 --aliases 他,孩子爸,爸爸
npm run family -- add --name 老婆 --aliases 她,孩子妈,妈妈
```

- `add` 会打印一条邀请链接 `…/join#token=…`。链接 7 天内有效，可以用 5 次（iPhone 的主屏幕 App 和 Safari 登录是分开的，所以一个人可能要用两次）。
- 邀请链接里的地址来自 `PUBLIC_URL`，**请先把 `PUBLIC_URL` 设成最终的 HTTPS 地址，再生成邀请**。之后要新链接就运行 `npm run family -- invite --member 老婆`。
- 别名（aliases）帮助 AI 和语音识别认出说的是谁：「让她明天……」里的「她」就是老婆。

其他命令：

```bash
npm run family -- list                         # 家庭、成员、登录设备、推送设备
npm run family -- invite --member 老婆          # 新的邀请链接（比如换了手机）
npm run family -- revoke --member 老婆          # 手机丢了：她的所有设备退出登录，作废她的邀请链接和她发出的邀请、推送、微信绑定、已发出的微信链接
npm run family -- test-notify --member 老婆     # 给她的所有设备发测试通知，并打印每个渠道的结果
```

`.env` 里改了任何东西，都要重启服务器才会生效。

---

## 运行

**正式使用（手机连这个）：**

```bash
npm run build      # 打包网页和服务器
npm start          # 在 PORT（默认 8787）上同时提供网页和 API
```

启动时会打印一份配置摘要，比如 AI、语音、推送、微信是否已开启，成员都有谁。

**开发模式（只在电脑浏览器里调试）：**

```bash
npm run dev        # API 在 8787，网页（Vite）在 http://localhost:5173
```

开发模式下 `PUBLIC_URL` 用默认的 `http://localhost:5173` 就行。手机长期使用请用正式模式（`npm run build && npm start`）。

**一直运行：**

- **Linux VPS**：用 systemd，下面是示例。`WorkingDirectory` 必须是项目目录，因为 `.env` 从那里读取。
  ```ini
  # /etc/systemd/system/family-share.service
  [Unit]
  Description=family_share
  After=network-online.target
  [Service]
  WorkingDirectory=/opt/family_share
  ExecStart=/usr/bin/node dist/server/index.js
  Restart=on-failure
  User=family
  [Install]
  WantedBy=multi-user.target
  ```
  然后运行 `sudo systemctl enable --now family-share`。停止时用 `systemctl stop`，服务器会把正在发的提醒发完再退出。
- **Mac**：
  - `bash scripts/install-service.sh`：装成登录后自动启动、意外退出会自动重启的后台服务（launchd），日志在 `data/logs/server.log`。
    更新代码后重新 `npm run build` 再运行一次；`--remove` 停止并移除。
  - 在「系统设置 → 能源」里打开「显示器关闭时防止自动进入睡眠」（Mac mini）。也可以用 `caffeinate -is npm start` 临时启动。
  - 笔记本合上盖子就会睡眠，这时不会发提醒。
  - 机器醒来后会补发错过的提醒：晚了 15 分钟以上的标题前加「（迟到）」，晚了 12 小时以上的到期提醒和摘要直接跳过。

**备份**：要备份的是整个 `DATA_DIR`（默认 `./data`）。数据库使用 WAL 模式，所以运行中请用 `sqlite3 data/family.db ".backup backup.db"` 备份，或者先停掉服务器再复制。建议执行 `chmod 700 data（新版本会自动设置）`，不让这台电脑上的其他账号读取。

---

## 让手机用上 HTTPS：Tailscale Funnel

手机上的通知、麦克风和「添加到主屏幕」都需要 HTTPS。最省事的办法是 Tailscale Funnel，它免费，不需要域名，也不用在路由器上开端口。

两个设置别搞混：

| 设置 | 意思 | 用 Funnel 时 |
|---|---|---|
| `HOST` | 服务器在这台电脑上监听哪个地址 | 保持 `127.0.0.1`：Funnel 在本机把公网请求转给 `127.0.0.1:8787` |
| `PUBLIC_URL` | 手机访问用的地址，邀请链接和通知链接都用它 | `https://<机器名>.<tailnet>.ts.net`，就是 `tailscale funnel status` 显示的地址 |

手机不需要装 Tailscale：Funnel 地址是公网地址，任何网络都能打开（微信回调也要靠它）。


1. 在运行服务器的机器上安装 Tailscale（<https://tailscale.com/download>）并登录。
2. **先定好机器名**。Tailscale 后台里机器名决定了地址 `https://<机器名>.<tailnet>.ts.net`。
3. 执行下面的命令。第一次运行时，命令行会给出一个链接，让你在后台开启 HTTPS 和 Funnel：
   ```bash
   tailscale funnel --bg 8787
   tailscale funnel status          # 查看公开地址
   ```
4. 把 `.env` 里的 `PUBLIC_URL` 设成这个地址（不要带结尾的 `/`），重启服务器，再生成邀请链接。
5. 关闭 Funnel：`tailscale funnel reset`。

**重要**：通知订阅、主屏幕 App 和登录状态都绑定在这个地址上。地址一换，每个人都要重新安装 App、重新开启通知，所以请一开始就选好最终地址。换 VAPID 密钥也一样，所有人都要重新开启通知。

**推荐用一直开机的机器或 VPS**。提醒由服务器定时发出，睡眠中的 Mac 一条都发不出去。

Funnel 地址是公开的，但所有接口都要登录，登录只能靠邀请链接。服务器默认只监听 `127.0.0.1`，由 Tailscale 转发进来。

---

## 安装到手机并开启通知

先把邀请链接发给家人（可以用微信发）。**请在系统浏览器里打开链接，不要在微信里打开**：在微信里点右上角 `···` →「在浏览器打开」。

**iPhone（需要 iOS 16.4 或更新版本）**

1. 用 **Safari** 打开邀请链接，页面会自动加入家庭。
2. 点屏幕下方的 **分享** 按钮，往下滑，选 **「添加到主屏幕」**。
3. 回到主屏幕，点「家庭同步」图标打开。主屏幕 App 和 Safari 的登录是分开的：如果要求登录，把同一个邀请链接粘贴进去即可。
4. 点 **「开启通知」**，然后点「允许」。iPhone 只有从主屏幕图标打开时才能开启通知。

**安卓（Chrome）**

1. 用 **Chrome** 打开邀请链接，页面会自动加入家庭。
2. 点右上角 `⋮` 菜单，选 **「安装应用」**（有的手机显示「添加到主屏幕」）。没安装的网页，Chrome 可能会自动收回通知权限，所以一定要安装。
3. 从桌面上的「家庭同步」图标打开，点 **「开启通知」**，然后点「允许」。

装好后，到 **设置 → 发送测试通知** 试一下。在设置里还可以改名字、别名、免打扰时间和每日摘要时间，大人也可以在「家人 → 邀请家人」里添加新成员。

---

## 微信提醒（公众号接口测试号，可选）

测试号免费，不需要 ICP 备案、营业执照或身份证。它可以随时给关注的人发模板消息（卡片很短，每个字段大约 20 个字，点开链接看详情），也能接收你发给它的文字。

1. **申请测试号**：在电脑上打开 <https://mp.weixin.qq.com/debug/cgi-bin/sandbox?t=sandbox/login>，用微信扫码登录，记下页面上的 **appID** 和 **appsecret**。
2. **新建测试模板**：在同一页面的「模板消息接口」里点「新增测试模板」。标题写「家庭任务提醒」，内容**照抄**（冒号不能少）：
   ```
   事项：{{task.DATA}}
   来自：{{from.DATA}}
   时间：{{when.DATA}}
   备注：{{note.DATA}}
   ```
   记下生成的 **模板 ID**。
3. **填写 `.env`**，然后重启服务器。四项都要填：缺了模板 ID，微信功能不会开启，回调也会验证失败。
   ```ini
   WECHAT_APPID=wx...
   WECHAT_APPSECRET=...
   WECHAT_TEMPLATE_ID=...
   WECHAT_TOKEN=<自己定的随机字符串，例如 openssl rand -hex 16 的输出>
   # WECHAT_FOLLOW_QR_URL=<测试号二维码图片地址，可选，会显示在设置页>
   ```
4. **接口配置信息**：服务器以 HTTPS 运行后，在测试号页面的「接口配置信息」里点「修改」：
   - **URL**：`https://<你的地址>/wechat/mp`，例如 `https://your-mac.your-tailnet.ts.net/wechat/mp`
   - **Token**：和 `WECHAT_TOKEN` 完全一样

   点「提交」后，微信会马上访问这个地址，显示「配置成功」就好了。
5. **两个人都关注测试号**：扫页面上的「测试号二维码」。如果二维码就在自己手机上，先截图，再用微信「扫一扫 → 相册」。
6. **绑定**：每个人在 App 里打开 **设置 → 绑定微信**，拿到 6 位绑定码（30 分钟内有效），在微信里给测试号发送 `绑定 123456`（换成自己的码）。收到「绑定成功，以后提醒会发到这里」就好了。
7. **选择发送方式**：在 设置 → 微信提醒 里选：
   - 「仅在App通知失效时」（默认）
   - 「两边都发」（第一次测试时推荐）
   - 「只发微信」
   - 「关闭」

**第一天请检查这几件事**（来自 `docs/research/wechat.md` §6）：

- 两部手机（iPhone 和安卓）都能收到模板卡片，字段显示正常。
- 点卡片里的链接，看微信是直接打开、出现蓝色提示（点「继续访问」）、白页，还是红色拦截。被拦截时，点 `···` →「在浏览器打开」。
- 发一句文字给测试号，比如「周六上午带孩子游泳」。它会先回「收到，处理中…」，稍后发来处理结果。

注意事项：

- 测试号关注人数上限大约是 20 人。
- 语音消息请在 App 里说，微信里请发文字。
- 不要在微信消息里写敏感内容（健康、钱、密码），内容会经过腾讯。

---

## 费用（2026 年 10 月的价格，粗略估计）

| 项目 | 价格 | 一个家庭大概 |
|---|---|---|
| Claude（默认 `claude-opus-5-5`） | 输入 $4、输出 $20 / 百万 token，缓存读取 $0.20 | 每句话约 $0.03–0.05（effort 越高越贵）；每天 20–40 句时每月约 **US$20–50** |
| 语音：本机 Whisper | 免费 | 在服务器那台电脑上跑，turbo 模型加载后约占 2–3 GB 内存，空闲 15 分钟释放 |
| 语音：OpenAI `gpt-transcribe` | $0.0045 / 分钟 | 每月约 300 分钟，约 US$1.4 |
| 语音：Qwen `qwen3-asr-flash`（国际站） | 约 $0.0021 / 分钟 | 每月约 US$0.6 |
| App 通知（Web Push） | 免费 | 0 |
| 微信公众号测试号 | 免费 | 0 |
| Tailscale（个人版） | 免费 | 0 |
| VPS（可选） | 每月几美元 | |

想省钱，可以在 `.env` 里把 `AI_EFFORT` 调成 `low`，或换 `AI_MODEL`。换之前先用 `npx tsx scripts/ai-eval.ts`（会真的调用 API，按量收费）对比一下理解质量。

确认 API key 能用：运行 `npx tsx scripts/ai-smoke.ts`，大约一分钟，花几美分。

---

## 隐私

- **数据存放**：所有数据都在你自己的机器上的 `DATA_DIR` 里。`family.db` 里是事项、对话、成员和通知记录，`audio/` 里是录音（只有服务器账号能读）。App 本身没有任何统计或埋点，除了下面列出的服务，数据不会发到别处。
- **Anthropic（Claude）**：会收到每句话的文字，以及当时的看板摘要（成员名字和别名、进行中的事项标题和备注、最近 8 句对话）。
- **OpenAI 或阿里云（语音识别）**：会收到录音，以及用来提高识别率的关键词（成员名字、别名和事项标题）。用本机 Whisper 时录音不出这台电脑。
- **腾讯（微信）**：会看到模板消息的内容（每个字段大约 20 个字）、你发给测试号的文字，以及你的 openid。
- **推送服务（Apple / Google / Mozilla）**：负责转交 App 通知。通知内容是端到端加密的，它们只看到加密数据和发送时间。
- **Tailscale Funnel**：流量会经过 Tailscale 的中继，但 HTTPS 在你自己的机器上才解开。
- **链接安全**：
  - 邀请链接相当于登录凭证，拿到链接的人可以以那个成员的身份加入。别在群里转发，丢了手机就用 `revoke` 作废。
  - 微信消息里的链接 72 小时内有效，只能查看和操作那一件事。

---

## 常见问题

| 现象 | 处理 |
|---|---|
| 启动报 `Invalid configuration` | 看报错里是哪个变量。通常是可选项留了空值（如 `STT_BASE_URL=`），改成注释即可 |
| `Port 8787 is already in use` | 已经有一个服务器在运行，或者在 `.env` 里换一个 `PORT` |
| 手机显示「请用家人发给你的邀请链接加入」 | 登录状态丢了（iPhone 主屏幕 App 和 Safari 登录是分开的），再打开一次邀请链接；链接过期就运行 `npm run family -- invite --member <名字>` |
| 没有「开启通知」按钮或提示不支持 | iPhone 需要 iOS 16.4 以上，并且必须从**主屏幕图标**打开；微信里打不开通知，请在浏览器里打开 |
| 测试通知提示「没有可以送达的设备」 | 启动摘要里 `web push: off` 说明没配 VAPID 密钥（运行 `npm run family -- vapid`，填进 `.env`，重启）；否则是这台手机还没开启通知。运行 `npm run family -- test-notify --member <名字>` 可以看到每个渠道的错误 |
| 换了地址或 VAPID 密钥后收不到通知 | 每个人在设置里重新点「开启通知」，必要时重新添加到主屏幕 |
| 晚上没收到提醒 | 默认 22:00–07:30 免打扰，可以在设置里改。「快到时间」（提前 60 分钟）和明确设的提醒不受免打扰影响 |
| 提醒标题带「（迟到）」或者没收到 | 服务器（或 Mac）当时在睡眠或关机。用一直开机的机器 |
| 回复「AI 还没配置」 | `.env` 里没有 `ANTHROPIC_API_KEY`，填好后重启 |
| 回复「AI 服务的配置有问题」 | key 或模型名不对，看服务器日志里的 `[ai] utterance … failed: auth / model_not_found` |
| 回复「AI 现在有点忙」 | Anthropic 限流或过载，稍后再说一次；已经做好的改动会保留 |
| 没有麦克风按钮 | 没配置语音识别（启动摘要里 `speech: off`），或者用 Qwen / Whisper 但找不到 ffmpeg（设置 `FFMPEG_PATH`，比如 `/opt/homebrew/bin/ffmpeg`），或者 `WHISPER_PYTHON` 不能 `import whisper`（启动时会打印原因）。键盘自带的语音输入照样能用 |
| 语音提示「没听清」 | 看服务器日志里的 `[stt]` 行；运行 `npm run family -- stt-test` 单独测一下语音识别 |
| 微信「配置失败」 | 确认地址是 `https://…/wechat/mp`，Token 和 `WECHAT_TOKEN` 一致，APPID/APPSECRET/TEMPLATE_ID 都填了并且已重启。在电脑上打开 `https://<地址>/wechat/mp`：显示 `wechat not configured` 说明 `.env` 没生效，显示 `invalid signature` 说明服务器已就绪 |
| 微信里发消息没反应 | 服务器时钟要准（误差 5 分钟以上的请求会被拒绝）；先在 App 里绑定；取消关注会自动解绑，重新关注后要再绑定一次 |
| 收不到微信模板消息 | 要先关注测试号并绑定；默认只有 App 通知失效时才发，测试时改成「两边都发」；用 `test-notify` 看错误码（43004 = 没关注，40037 = 模板 ID 错误） |
| 重启后某句话显示出错 | 服务器重启时那句话还没处理完，再说一次即可，之前已经做好的改动可以撤销 |

开发者可以运行 `npm test` 跑全部测试，运行 `npm run typecheck` 做类型检查。规格说明在 `docs/SPEC.md`，调研资料在 `docs/research/`。

---

## English summary

**family_share** is a self-hosted coordination app for one family. People speak or type in Chinese, and Claude turns each sentence into changes on a shared board: tasks, requests (another member must accept or decline), ideas and reminders. Every change can be undone. A deterministic scheduler on the server sends reminders, request follow-ups, a daily digest, stale-task nudges and a Sunday weekly review. Notifications go through Web Push from the installed PWA, with an optional WeChat Official Account test account (template messages, plus texting the assistant). All data stays in `DATA_DIR`: a SQLite database and the voice recordings.

**Prerequisites:**
- Node 24.
- ffmpeg: recommended, and required for Qwen speech-to-text.
- An always-on machine or VPS. A sleeping Mac sends no reminders.
- An Anthropic API key.
- Optional: an OpenAI key (`gpt-transcribe`) or an Alibaba Model Studio intl key (`qwen3-asr-flash`) for hold-to-talk voice.
- Optional: Tailscale for HTTPS.

**Setup:**
```bash
npm install
cp .env.example .env              # set PUBLIC_URL, FAMILY_TIMEZONE, ANTHROPIC_API_KEY (+ OPENAI_API_KEY for voice)
npm run family -- init --name 我们家 --timezone Australia/Sydney
npm run family -- vapid           # paste both keys into .env
npm run family -- add --name 老公 --aliases 他,孩子爸
npm run family -- add --name 老婆 --aliases 她,孩子妈   # each prints an invite link (7 days, 5 uses)
npm run build && npm start        # production: web app + API on PORT (8787)
npm run dev                       # development: API on 8787, Vite on http://localhost:5173
```

**HTTPS for phones:**
- Run `tailscale funnel --bg 8787`, then set `PUBLIC_URL` to the `https://<machine>.<tailnet>.ts.net` address and restart.
- Push subscriptions, home-screen installs and sessions are tied to that origin, so pick the final hostname before inviting anyone.

**Phones:**
- iPhone (iOS 16.4+): Safari → Share → Add to Home Screen. Open the app from the icon, paste the invite again if it asks you to sign in, then tap 开启通知.
- Android: Chrome → ⋮ → Install app. Open the app from the icon, then tap 开启通知.
- Test with 设置 → 发送测试通知.

**WeChat setup:**
1. Create a sandbox test account at `mp.weixin.qq.com/debug/cgi-bin/sandbox?t=sandbox/login`.
2. Add a test template with the fields 事项/来自/时间/备注, in the form `{{task.DATA}} {{from.DATA}} {{when.DATA}} {{note.DATA}}`.
3. Set `WECHAT_APPID`, `WECHAT_APPSECRET`, `WECHAT_TEMPLATE_ID` and `WECHAT_TOKEN`, then restart.
4. Under 接口配置信息, set the URL to `https://<host>/wechat/mp` and use the same token.
5. Both members follow the test account.
6. Each member binds through 设置 → 绑定微信 by sending `绑定 <code>` to the account.

**Costs:**
- Roughly US$20–50 a month for Claude at 20–40 sentences a day.
- About US$1 a month for speech-to-text.
- Push, the WeChat test account and Tailscale are free.

**Privacy:**
- Anthropic sees each sentence plus a board summary.
- The STT provider sees the recordings plus name and title keywords.
- Tencent sees WeChat message contents.
- Push services only relay encrypted payloads.
