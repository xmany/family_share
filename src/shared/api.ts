// HTTP API contracts between the web app and the server.
// Web app routes are PATH routes (not hash routes): /, /board, /item/:id, /weekly, /settings, /join, /t/:token.
// The server serves index.html for any non-/api, non-asset path.
// All routes are under /api, JSON in/out, authenticated by the httpOnly `fs_session` cookie
// (except POST /api/auth/join). Mutating requests must send the header `X-Family-Share: 1`
// (cheap CSRF guard on top of SameSite=Lax cookies).

import type {
  WechatMode,
  Clarification,
  Family,
  Item,
  ItemEvent,
  Member,
  Note,
  ScheduledNotification,
  Utterance,
} from './types'

export interface ApiError {
  error: { code: string; message: string }
}

// POST /api/auth/join  { token }  -> sets cookie, returns JoinResponse
export interface JoinBody {
  token: string
}
export interface JoinResponse {
  me: Member
}

// POST /api/auth/logout -> { ok: true }

// GET /api/me
export interface MeResponse {
  me: Member
  family: Family
  /** VAPID public key for web push, null if push is not configured on the server */
  vapidPublicKey: string | null
  /** Whether server-side speech-to-text is configured (otherwise the UI relies on keyboard dictation) */
  sttEnabled: boolean
  /** Notification channels this server supports, e.g. ["webpush", "wechat"] */
  channels: string[]
}

// GET /api/board
// Active items + items closed in the last 7 days, all members, and the 30 most recent utterances.
export interface BoardResponse {
  me: Member
  family: Family
  members: Member[]
  items: Item[]
  utterances: Utterance[]
  serverTime: string
}

// GET /api/items/:id
export interface ItemDetailResponse {
  item: Item
  notes: Note[]
  events: ItemEvent[]
  notifications: ScheduledNotification[]
}

// POST /api/utterances  { text, source?: 'text' | 'clarification' }
export interface UtteranceBody {
  text: string
  source?: 'text' | 'clarification'
  /** When answering a clarification: the utterance that asked */
  replyToUtteranceId?: string
}
// POST /api/utterances/voice  multipart/form-data: audio=<blob>, (optional) durationMs
// Both return UtteranceResponse. On STT failure: 422 with ApiError code "stt_failed".
export interface UtteranceResponse {
  utterance: Utterance
  /** Latest state of every item this utterance touched */
  items: Item[]
  /** Voice only: the transcript that was interpreted */
  transcript?: string
}

// POST /api/utterances/:id/undo -> UndoResponse
export interface UndoResponse {
  utterance: Utterance
  items: Item[]
}

// Manual item operations (buttons in the UI). Each returns ItemResponse.
// POST  /api/items                    CreateItemBody
// PATCH /api/items/:id                UpdateItemBody
// POST  /api/items/:id/respond        RespondBody     (owner of a pending request)
// POST  /api/items/:id/complete       CompleteBody
// POST  /api/items/:id/snooze         SnoozeBody
// POST  /api/items/:id/notes          NoteBody
export interface ItemResponse {
  item: Item
}
export interface CreateItemBody {
  kind: Item['kind']
  title: string
  details?: string
  ownerId?: string
  dueAt?: string
  dueDate?: string
  priority?: Item['priority']
}
export interface UpdateItemBody {
  kind?: Exclude<Item['kind'], 'request'>
  title?: string
  details?: string | null
  status?: Item['status']
  ownerId?: string | null
  dueAt?: string | null
  dueDate?: string | null
  priority?: Item['priority']
}
export interface RespondBody {
  response: 'accept' | 'decline'
  message?: string
}
export interface CompleteBody {
  note?: string
}
/** Either an explicit instant or a preset resolved on the server in the family timezone */
export interface SnoozeBody {
  until?: string
  preset?: 'tonight' | 'tomorrow' | 'weekend' | 'next_week'
}
export interface NoteBody {
  text: string
}

// Signed item links (WeChat messages link here; WeChat's in-app browser has no session).
// GET  /api/t/:token          -> LinkViewResponse   (no session needed; the token is the credential)
// POST /api/t/:token/action   LinkActionBody -> LinkViewResponse
export interface LinkViewResponse {
  item: Item
  members: Member[]
  /** The member the link was sent to */
  memberId: string
  allowed: Array<'accept' | 'decline' | 'done'>
  family: Family
}
export interface LinkActionBody {
  action: 'accept' | 'decline' | 'done'
  message?: string
}

// Notification actions coming from the service worker (no page open).
// POST /api/notifications/:id/action  { action }  -> { ok: true }
export interface NotificationActionBody {
  action: 'accept' | 'decline' | 'done' | 'snooze_tonight' | 'snooze_tomorrow'
}

// Web push
// GET    /api/push/vapid-public-key -> { key: string | null }
// POST   /api/push/subscriptions     PushSubscribeBody -> { ok: true }
// DELETE /api/push/subscriptions     { endpoint } -> { ok: true }
// POST   /api/push/test              -> { ok: true, delivered: number }
export interface PushSubscribeBody {
  subscription: {
    endpoint: string
    expirationTime?: number | null
    keys: { p256dh: string; auth: string }
  }
}

// Settings for the signed-in member
// GET /api/settings -> SettingsResponse ; PUT /api/settings SettingsBody -> SettingsResponse
export interface ChannelSetting {
  channel: string
  enabled: boolean
  /**
   * Channel-specific, non-secret settings.
   * wechat: { mode: WechatMode } — the bound openid is set only through the bind flow and is
   * returned masked as { bound: "yes" | "no" }.
   */
  config: Record<string, string>
}
export interface SettingsResponse {
  me: Member
  channels: ChannelSetting[]
  /** Number of browsers/phones with web push enabled for me */
  pushDevices: number
  /** Whether my web push looks healthy (a success in the last 7 days, or a fresh subscription) */
  pushHealthy: boolean
  wechat: {
    /** Server has WeChat test-account credentials */
    available: boolean
    bound: boolean
    mode: WechatMode
    /** Image URL of the test account's follow QR (WECHAT_FOLLOW_QR_URL), if configured */
    followQrUrl: string | null
  }
}

// WeChat binding (member sends "绑定 <code>" to the WeChat test account)
// POST /api/wechat/bind-code -> WechatBindCodeResponse
export interface WechatBindCodeResponse {
  code: string
  expiresAt: string
  /** e.g. "关注测试号后，发送：绑定 482913" */
  instructions: string
}
export interface SettingsBody {
  name?: string
  aliases?: string[]
  quietStart?: string
  quietEnd?: string
  digestTime?: string | null
  channels?: ChannelSetting[]
}

// Family management (adults only)
// GET  /api/members -> { members: Member[] }
// POST /api/members  NewMemberBody -> InviteResponse   (creates member + invite link)
// POST /api/members/:id/invite -> InviteResponse       (new invite link for an existing member, e.g. a new phone)
export interface NewMemberBody {
  name: string
  aliases?: string[]
  role: Member['role']
}
export interface InviteResponse {
  member: Member
  /** Full URL to open on the member's phone: `${PUBLIC_URL}/join#token=...` (reusable up to 5 times until expiry) */
  inviteUrl: string
  expiresAt: string
}

// Server-sent events: GET /api/stream  (text/event-stream, event name "message", data = ServerEvent JSON)
export type ServerEvent =
  | { type: 'hello'; serverTime: string }
  | { type: 'board_changed'; itemIds: string[]; utteranceId?: string; byMemberId?: string | null }
  | { type: 'utterance'; utterance: Utterance }
  | { type: 'ping' }

export type { Clarification }
