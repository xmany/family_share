// Live-model eval set for the interpreter (run by scripts/ai-eval.ts; never by vitest).
//
// Every case runs in a fresh createTestContext(): Wed 2026-10-21 12:00 Australia/Sydney, members
// 老公 (husband) and 老婆 (wife). Relative dates: "+0" = 2026-10-21 (周三), "+1" = 周四 10-22,
// "+2" = 周五 10-23, "+3" = 周六 10-24, "+4" = 周日 10-25, "+5" = 下周一 10-26, "+6" = 下周二 10-27.

import type { ItemKind, ItemStatus } from '../../../shared/types'
import type { ToolName } from '../tools'

export type MemberKey = 'husband' | 'wife'

export interface SeedItem {
  /** Name used by expectations, e.g. "cabinet" */
  key: string
  kind: ItemKind
  title: string
  /** Owner (task/reminder/idea) or the person asked (request). null = unassigned idea */
  owner: MemberKey | null
  /** Requests only: who asked */
  requestedBy?: MemberKey
  /** "+N" days from today, or YYYY-MM-DD */
  dueDate?: string
  /** HH:MM; with dueDate makes a dueAt */
  dueTime?: string
  /** Reached through the domain after creation (e.g. 'declined', 'accepted', 'in_progress', 'done') */
  status?: ItemStatus
  notes?: string[]
  /** Extra pings set with setReminder before the status change ("+N" or YYYY-MM-DD, HH:MM); member defaults to the owner */
  reminders?: Array<{ date: string; time: string; member?: MemberKey }>
}

export interface ExpectedCall {
  /** The tool (or any of these tools) that must have been called successfully */
  tool: ToolName | ToolName[]
  /** to_member_id (send_request) / owner_id / member_ids */
  member?: MemberKey
  /** Seed key that item_id / existing_item_id must point at */
  item?: string
  /** The title must contain one of these */
  titleIncludes?: string[]
  /** "+N", YYYY-MM-DD, or "none" (no date given) — due_date / remind_date / until_date */
  date?: string
  /** HH:MM or "none" — due_time / remind_time / until_time */
  time?: string
  kind?: 'task' | 'idea' | 'reminder'
  resolution?: 'done' | 'dropped'
  response?: 'accept' | 'decline'
  preset?: string
  status?: string
  priority?: 'low' | 'normal' | 'high'
  /** details / text / note / message must contain one of these */
  textIncludes?: string[]
}

export interface EvalCase {
  id: string
  speaker: MemberKey
  text: string
  /** 'wechat': the reply lands in a WeChat template field cut after 20 characters (wechat/format.ts) */
  source?: 'text' | 'voice' | 'wechat'
  /** Speaker's member.language when not zh-CN */
  speakerLanguage?: string
  seed?: SeedItem[]
  /** Each must be matched by at least one successful tool call */
  expect: ExpectedCall[]
  /** Tools that must NOT be called successfully */
  forbid?: ToolName[]
  /** Final utterance status (default 'done') */
  outcome?: 'done' | 'clarify'
  /** Regex (source) the reply must match */
  replyMatches?: string
  /** 'traditional' → reply must contain Traditional characters; 'english' → no CJK characters */
  replyScript?: 'traditional' | 'english'
  why: string
}

const MUTATING: ToolName[] = [
  'create_item',
  'update_item',
  'add_note',
  'send_request',
  'respond_to_request',
  'complete_item',
  'snooze_item',
  'set_reminder',
  'cancel_reminder',
]

/** A WeChat reply arrives whole only up to WECHAT_VALUE_MAX (20) characters (sanitizeWechatValue). */
export const WECHAT_REPLY = '^.{1,20}$'

export const CASES: EvalCase[] = [
  {
    id: 'request-milk-after-work',
    speaker: 'wife',
    text: '让老公明天下班顺路把牛奶买了',
    source: 'voice',
    expect: [{ tool: 'send_request', member: 'husband', titleIncludes: ['牛奶'], date: '+1', time: '18:30' }],
    forbid: ['create_item'],
    replyMatches: '18:30|六点半',
    why: 'someone else → send_request; 下班顺路 = 18:30 default, stated in the reply',
  },
  {
    id: 'cabinet-progress-update',
    speaker: 'wife',
    text: '柜子挂到Facebook上了，80块，周日可能有人来拿',
    seed: [{ key: 'cabinet', kind: 'task', title: '卖旧柜子', owner: 'wife' }],
    expect: [{ tool: ['add_note', 'update_item'], item: 'cabinet' }],
    forbid: ['create_item', 'send_request'],
    why: 'progress on an existing item is an update/note, not a new item',
  },
  {
    id: 'drop-rug',
    speaker: 'wife',
    text: '算了地毯先不买了',
    seed: [{ key: 'rug', kind: 'task', title: '买地毯', owner: 'wife' }],
    expect: [{ tool: 'complete_item', item: 'rug', resolution: 'dropped' }],
    forbid: ['create_item'],
    why: '算了 = dropped, never deleted',
  },
  {
    id: 'husband-asks-wife-kids-morning',
    speaker: 'husband',
    text: '我九点有个会，明天早上你能带孩子出去吗',
    source: 'voice',
    expect: [{ tool: 'send_request', member: 'wife', date: '+1', time: '08:00', textIncludes: ['会', '九点', '9点', '09:00'] }],
    forbid: ['create_item'],
    replyMatches: '8[:：]00|八点|8点',
    why: '你 = the other adult; 明天早上 = 08:00; the meeting goes into details',
  },
  {
    id: 'ambiguous-that-one-done',
    speaker: 'husband',
    text: '那个弄好了',
    source: 'voice',
    seed: [
      { key: 'door', kind: 'task', title: '修柜门', owner: 'husband' },
      { key: 'curtain', kind: 'task', title: '装窗帘', owner: 'husband' },
    ],
    expect: [],
    forbid: ['complete_item', 'update_item'],
    outcome: 'clarify',
    why: 'two candidates → ask instead of guessing',
  },
  {
    id: 'remind-call-grandma-tonight',
    speaker: 'wife',
    text: '提醒我晚上给外婆打电话',
    expect: [{ tool: 'create_item', kind: 'reminder', date: '+0', time: '20:00', titleIncludes: ['外婆'] }],
    forbid: ['send_request'],
    replyMatches: '20[:：]00|八点|8点',
    why: 'reminder for the speaker; 晚上 = 20:00',
  },
  {
    id: 'date-only-task',
    speaker: 'wife',
    text: '明天交水费',
    expect: [{ tool: 'create_item', kind: 'task', date: '+1', time: 'none', titleIncludes: ['水费'] }],
    why: 'no time of day said → due_date only',
  },
  {
    id: 'saturday-morning-swim',
    speaker: 'husband',
    text: '周六上午带孩子去游泳',
    expect: [{ tool: 'create_item', date: '+3', time: '10:00', titleIncludes: ['游泳'] }],
    forbid: ['send_request'],
    why: 'weekday from the calendar; 上午 = 10:00',
  },
  {
    id: 'someday-idea',
    speaker: 'wife',
    text: '以后有空可以去塔斯马尼亚玩一趟',
    expect: [{ tool: 'create_item', kind: 'idea', date: 'none', titleIncludes: ['塔斯马尼亚'] }],
    why: 'no deadline → idea',
  },
  {
    id: 'accept-request',
    speaker: 'wife',
    text: '好的，周六我带他们去',
    seed: [{ key: 'swim', kind: 'request', title: '带孩子游泳', owner: 'wife', requestedBy: 'husband', dueDate: '+3', dueTime: '08:30' }],
    expect: [{ tool: 'respond_to_request', item: 'swim', response: 'accept' }],
    forbid: ['create_item', 'send_request'],
    why: 'answering a pending request addressed to the speaker',
  },
  {
    id: 'decline-request-with-reason',
    speaker: 'wife',
    text: '周六我要加班，去不了',
    seed: [{ key: 'swim', kind: 'request', title: '带孩子游泳', owner: 'wife', requestedBy: 'husband', dueDate: '+3', dueTime: '08:30' }],
    expect: [{ tool: 'respond_to_request', item: 'swim', response: 'decline', textIncludes: ['加班'] }],
    why: 'decline with the reason as the message',
  },
  {
    id: 'milk-bought',
    speaker: 'husband',
    text: '牛奶买好了',
    seed: [{ key: 'milk', kind: 'task', title: '买牛奶', owner: 'husband', dueDate: '+0' }],
    expect: [{ tool: 'complete_item', item: 'milk', resolution: 'done' }],
    forbid: ['create_item'],
    why: '买好了 = done',
  },
  {
    id: 'snooze-photos',
    speaker: 'wife',
    text: '照片的事明天再说吧',
    seed: [{ key: 'photos', kind: 'task', title: '整理照片', owner: 'wife' }],
    expect: [{ tool: ['snooze_item', 'update_item'], item: 'photos' }],
    forbid: ['create_item', 'complete_item'],
    why: '明天再说 = postpone, not close',
  },
  {
    id: 'repeating-trash',
    speaker: 'wife',
    text: '每周二提醒我倒垃圾',
    expect: [{ tool: 'create_item', date: '+6', titleIncludes: ['垃圾'] }],
    replyMatches: '重复|还不支持|暂不支持|暂时不支持|不能自动',
    why: 'repeats unsupported in v0: create the next occurrence and say so',
  },
  {
    id: 'next-wednesday-movie',
    speaker: 'husband',
    text: '下周三晚上和老婆去看电影',
    expect: [{ tool: 'create_item', date: '2026-10-28', time: '20:00', titleIncludes: ['电影'] }],
    why: '下周三 from the calendar row; 晚上 = 20:00',
  },
  {
    id: 'request-car-service-by-friday',
    speaker: 'wife',
    text: '麻烦老公这周五之前把车送去保养',
    expect: [{ tool: 'send_request', member: 'husband', date: '+2', titleIncludes: ['保养', '车'] }],
    forbid: ['create_item'],
    why: '麻烦 + person → request; 这周五 date only',
  },
  {
    id: 'traditional-text-simplified-speaker',
    speaker: 'wife',
    text: '幫我記一下，明天下午三點去接孩子',
    expect: [{ tool: 'create_item', date: '+1', time: '15:00', titleIncludes: ['接孩子', '接'] }],
    why: 'Traditional input from a zh-CN member; 下午三點 = 15:00',
  },
  {
    id: 'traditional-speaker-reply-script',
    speaker: 'wife',
    speakerLanguage: 'zh-TW',
    text: '提醒我明天早上八點吃藥',
    expect: [{ tool: 'create_item', kind: 'reminder', date: '+1', time: '08:00' }],
    replyScript: 'traditional',
    why: 'zh-TW member → reply in Traditional',
  },
  {
    id: 'english-reminder',
    speaker: 'husband',
    text: 'remind me to call the dentist tomorrow at 10am',
    expect: [{ tool: 'create_item', kind: 'reminder', date: '+1', time: '10:00' }],
    replyScript: 'english',
    why: 'English utterance → English reply',
  },
  {
    id: 'mixed-language-task',
    speaker: 'wife',
    text: '明天记得book一下dentist',
    expect: [{ tool: 'create_item', date: '+1', titleIncludes: ['dentist', '牙'] }],
    why: 'mixed Chinese/English',
  },
  {
    id: 'turn-own-task-into-request',
    speaker: 'wife',
    text: '牛奶让老公买吧',
    seed: [{ key: 'milk', kind: 'task', title: '买牛奶', owner: 'wife', dueDate: '+1' }],
    expect: [{ tool: 'send_request', member: 'husband', item: 'milk' }],
    forbid: ['create_item'],
    why: 'existing item → send_request with existing_item_id, no duplicate',
  },
  {
    id: 'remind-owner-of-his-task',
    speaker: 'wife',
    text: '提醒老公周六修自行车',
    seed: [{ key: 'bike', kind: 'task', title: '修自行车', owner: 'husband' }],
    expect: [{ tool: ['set_reminder', 'update_item'], item: 'bike' }],
    forbid: ['send_request', 'create_item'],
    why: 'he already owns it → remind/update, not a new request',
  },
  {
    id: 'split-chores',
    speaker: 'wife',
    text: '这个周末大扫除，我负责厨房，老公负责客厅',
    expect: [
      { tool: 'create_item', titleIncludes: ['厨房'] },
      { tool: 'send_request', member: 'husband', titleIncludes: ['客厅'] },
    ],
    why: 'own part → task; his part → request (both in one turn)',
  },
  {
    id: 'reschedule-bill',
    speaker: 'husband',
    text: '电费改到下周一交',
    seed: [{ key: 'power', kind: 'task', title: '交电费', owner: 'husband', dueDate: '+2' }],
    expect: [{ tool: 'update_item', item: 'power', date: '+5' }],
    forbid: ['create_item'],
    why: 'reschedule = update_item due_change set',
  },
  {
    id: 'question-no-changes',
    speaker: 'wife',
    text: '老公答应带孩子游泳了吗？',
    seed: [{ key: 'swim', kind: 'request', title: '带孩子游泳', owner: 'husband', requestedBy: 'wife', dueDate: '+3', dueTime: '08:30' }],
    expect: [],
    forbid: MUTATING,
    replyMatches: '还没|没有|未|等',
    why: 'questions are answered from the snapshot without changes',
  },
  {
    id: 'lunar-birthday-cake',
    speaker: 'wife',
    text: '农历九月十五是外婆生日，提前一天提醒我买蛋糕',
    expect: [{ tool: 'create_item', date: '+2', titleIncludes: ['蛋糕'] }],
    why: '农历九月十五 = 2026-10-24 from the calendar; one day earlier = 10-23',
  },
  {
    id: 'voice-homophone-passport',
    speaker: 'husband',
    text: '明天早上提醒我带户照',
    source: 'voice',
    expect: [{ tool: 'create_item', kind: 'reminder', date: '+1', time: '08:00' }],
    why: 'recognition error (户照 → 护照) still a reminder at 08:00',
  },
  {
    id: 'cabinet-sold',
    speaker: 'wife',
    text: '旧柜子卖掉了，卖了70',
    seed: [{ key: 'cabinet', kind: 'task', title: '卖旧柜子', owner: 'wife', status: 'in_progress', notes: ['挂到Facebook上了，80块'] }],
    expect: [{ tool: 'complete_item', item: 'cabinet', resolution: 'done' }],
    forbid: ['create_item'],
    why: 'done, with the price as a note',
  },
  {
    id: 'vague-reference-clarify',
    speaker: 'wife',
    text: '让她明天带一下那个',
    source: 'voice',
    expect: [],
    forbid: ['send_request', 'create_item'],
    outcome: 'clarify',
    why: 'no idea what 那个 is, and the wife\'s 她 is not herself (her alias) nor the husband → ask',
  },
  {
    id: 'urgent-request',
    speaker: 'wife',
    text: '叫老公明天别忘了给车加油，这个很急',
    expect: [{ tool: 'send_request', member: 'husband', date: '+1', priority: 'high' }],
    why: '很急 → priority high',
  },
  {
    id: 'resend-declined-request',
    speaker: 'wife',
    text: '那再问问他，改到周日行不行',
    seed: [{ key: 'swim', kind: 'request', title: '带孩子游泳', owner: 'husband', requestedBy: 'wife', dueDate: '+3', dueTime: '08:30', status: 'declined' }],
    expect: [{ tool: 'send_request', member: 'husband', item: 'swim', date: '+4' }],
    forbid: ['create_item'],
    why: 're-send the declined request (existing_item_id) with the new day',
  },
  {
    id: 'pickup-this-afternoon',
    speaker: 'husband',
    text: '今天下午3点接孩子',
    expect: [{ tool: 'create_item', date: '+0', time: '15:00' }],
    why: '3点 for school pickup in the afternoon = 15:00 today (still ahead at 12:00)',
  },
  {
    id: 'wife-calls-her-own-mother',
    speaker: 'wife',
    text: '提醒我今晚给妈妈打电话',
    expect: [{ tool: 'create_item', kind: 'reminder', date: '+0', time: '20:00', titleIncludes: ['妈'] }],
    forbid: ['send_request', 'set_reminder'],
    why: '妈妈 is one of the wife\'s own aliases, but from her it means her mother (not a member): a reminder for the speaker',
  },
  {
    id: 'husband-says-her',
    speaker: 'husband',
    text: '叫她明天去取一下快递',
    expect: [{ tool: 'send_request', member: 'wife', date: '+1', titleIncludes: ['快递'] }],
    forbid: ['create_item'],
    why: '她 with nobody mentioned, said by one adult = the other adult; asking someone → send_request',
  },
  {
    id: 'reschedule-keeps-time',
    speaker: 'husband',
    text: '游泳改到周日',
    seed: [{ key: 'swim', kind: 'task', title: '带孩子游泳', owner: 'husband', dueDate: '+3', dueTime: '08:30' }],
    expect: [{ tool: 'update_item', item: 'swim', date: '+4', time: '08:30' }],
    forbid: ['create_item'],
    why: 'only the day changes: the 08:30 time must be sent again, or the item becomes date-only',
  },
  {
    id: 'date-beyond-calendar-next-year',
    speaker: 'wife',
    text: '1月5号之前要交车险',
    expect: [{ tool: ['create_item', 'update_item'], date: '2027-01-05' }],
    why: 'a month/day earlier than today means next year (no calendar row for it); a 2026 slip gets a past-date warning and may be fixed with update_item',
  },
  {
    id: 'owner-backs-out-pending',
    speaker: 'wife',
    text: '那个算了吧，周六我去不了',
    seed: [{ key: 'out', kind: 'request', title: '带孩子出去', owner: 'wife', requestedBy: 'husband', dueDate: '+3', dueTime: '08:00' }],
    expect: [{ tool: 'respond_to_request', item: 'out', response: 'decline' }],
    forbid: ['complete_item'],
    why: '算了 about a pending request addressed to the speaker is a decline (the requester is told), not a silent drop',
  },
  {
    id: 'owner-backs-out-accepted',
    speaker: 'wife',
    text: '周六那个算了，我去不了了',
    seed: [{ key: 'out', kind: 'request', title: '带孩子出去', owner: 'wife', requestedBy: 'husband', dueDate: '+3', dueTime: '08:00', status: 'accepted' }],
    expect: [{ tool: 'complete_item', item: 'out', resolution: 'dropped', textIncludes: ['去不了'] }],
    why: 'an accepted request can no longer be declined: drop it with the reason as the note (the result says whether 老公 was told)',
  },
  {
    id: 'requester-takes-back-accepted',
    speaker: 'husband',
    text: '牛奶算了，我自己买吧',
    seed: [{ key: 'milk', kind: 'request', title: '买牛奶', owner: 'wife', requestedBy: 'husband', dueDate: '+1', status: 'accepted' }],
    expect: [
      { tool: 'complete_item', item: 'milk', resolution: 'dropped' },
      { tool: 'create_item', titleIncludes: ['牛奶'] },
    ],
    forbid: ['send_request'],
    why: 'taking back a request: drop it, then a task for the speaker',
  },
  {
    id: 'cancel-reminder-item',
    speaker: 'wife',
    text: '取消明天的提醒',
    seed: [{ key: 'call', kind: 'reminder', title: '给外婆打电话', owner: 'wife', dueDate: '+1', dueTime: '20:00' }],
    expect: [{ tool: 'complete_item', item: 'call', resolution: 'dropped' }],
    forbid: ['create_item'],
    why: 'a kind reminder item is the ping itself: cancelling it drops the item',
  },
  {
    id: 'cancel-extra-ping',
    speaker: 'husband',
    text: '取消明天的提醒',
    seed: [{ key: 'passport', kind: 'task', title: '带护照', owner: 'husband', dueDate: '+1', reminders: [{ date: '+1', time: '07:00' }] }],
    expect: [{ tool: 'cancel_reminder', item: 'passport', date: '+1', time: '07:00' }],
    forbid: ['complete_item'],
    why: 'an extra ping (另有提醒) on a task is cancelled on its own; the task stays',
  },
  {
    id: 'postpone-dated-bill',
    speaker: 'wife',
    text: '水费下周再说吧',
    seed: [{ key: 'bill', kind: 'task', title: '交水费', owner: 'wife', dueDate: '+1' }],
    expect: [{ tool: ['update_item', 'snooze_item'], item: 'bill' }],
    forbid: ['complete_item', 'create_item'],
    why: 'postpone, not close: a new due date next week, or a snooze that silences the bill (its due ping too) until next week',
  },
  {
    id: 'wechat-request-short-reply',
    speaker: 'wife',
    text: '让老公明天下班顺路把牛奶买了',
    source: 'wechat',
    expect: [{ tool: 'send_request', member: 'husband', titleIncludes: ['牛奶'], date: '+1', time: '18:30' }],
    forbid: ['create_item'],
    replyMatches: '^(?=.*(18:30|六点半)).{1,20}$',
    why: 'WeChat cuts the reply after 20 characters: one short sentence that still states the assumed time',
  },
  {
    id: 'wechat-board-question',
    speaker: 'wife',
    text: '我们家还有什么没做的？',
    source: 'wechat',
    seed: [
      { key: 'bill', kind: 'task', title: '交水费', owner: 'wife', dueDate: '+1' },
      { key: 'photos', kind: 'task', title: '整理照片', owner: 'wife' },
      { key: 'bike', kind: 'task', title: '修自行车', owner: 'husband', dueDate: '+3' },
      { key: 'curtain', kind: 'task', title: '装窗帘', owner: 'husband' },
      { key: 'swim', kind: 'request', title: '带孩子游泳', owner: 'husband', requestedBy: 'wife', dueDate: '+3', dueTime: '08:30' },
    ],
    expect: [],
    forbid: MUTATING,
    replyMatches: WECHAT_REPLY,
    why: 'a board question on WeChat: the count and the most urgent item in one sentence that fits the field',
  },
]
