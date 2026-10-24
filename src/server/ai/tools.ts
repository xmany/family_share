// Tool contract between Claude and the board.
//
// TOOLS is the wire format: fixed order, byte-stable, strict. It is a module constant and is never
// rebuilt per request (tools render first in the prompt; any change invalidates the whole prompt cache).
// No `pattern` / `minLength` / numeric constraints and no nullable fields (strict-mode grammar limits):
// ids and HH:MM times are validated here with zod instead, and a bad value comes back to Claude as an
// is_error tool result it can correct.
//
// SCHEMAS re-validates every input on our side before anything touches the domain.
import type { BetaTool } from '@anthropic-ai/sdk/resources/beta/messages/messages'
import { z } from 'zod'

// Ids come from src/server/ids.ts: prefix + 10 chars of 0-9a-z without l/o.
export const ITEM_ID_RE = /^i_[0-9a-km-np-z]{10}$/
export const MEMBER_ID_RE = /^m_[0-9a-km-np-z]{10}$/
export const HHMM_RE = /^([01][0-9]|2[0-3]):[0-5][0-9]$/

type Schema = Record<string, unknown>
const str = (description: string): Schema => ({ type: 'string', description })
const date = (description: string): Schema => ({ type: 'string', format: 'date', description })
const oneOf = (values: readonly string[], description: string): Schema => ({ type: 'string', enum: [...values], description })
const bool = (description: string): Schema => ({ type: 'boolean', description })

/**
 * Required properties go first on the wire. With an optional property listed before a required one, strict
 * mode never let Opus 5.5 emit the optionals that followed: every create_item came back without due_date /
 * due_time, so reminders failed until the iteration cap. Declared order is kept within each group.
 */
function tool(name: string, description: string, properties: Record<string, Schema>, required: string[]): BetaTool {
  const entries = Object.entries(properties)
  const ordered = Object.fromEntries([...entries.filter(([k]) => required.includes(k)), ...entries.filter(([k]) => !required.includes(k))])
  return {
    name,
    description,
    strict: true,
    input_schema: { type: 'object', properties: ordered, required, additionalProperties: false },
  }
}

const ITEM = 'Item id (i_…) copied from active_items, closed_last_7_days or a search_items result.'
const MEMBER = 'Member id (m_…) copied from the members list.'
const DUE_DATE = 'Local date YYYY-MM-DD in the family timezone, copied from the calendar in the snapshot.'
const DUE_TIME = 'Local wall-clock time HH:MM (24h), e.g. "18:30". Only together with a date. Omit when no time of day was said or implied.'
/** Rescheduling: a date without a time turns a timed item into a date-only one, so the old time must be repeated. */
const NEW_DUE_TIME = `${DUE_TIME} When the item already has a time and only the day changes (改到周日), send its current time again; a date without a time removes the time.`
const PRIORITY = '"high" only when the speaker signals urgency (急 / 马上 / 一定要 / urgent); "low" when they say it does not matter; otherwise "normal".'

export const TOOLS: BetaTool[] = [
  tool(
    'search_items',
    'Search the whole board, including items that are closed or too old to be in the snapshot. Call this before creating something when the speaker refers to a thing that may already exist (那个 / 上次说的 / 之前的) but you cannot find it in active_items, or when they ask about past items. Matching is by substring on title, details and notes; Traditional and Simplified match each other.',
    {
      query: str('One or more short keywords separated by spaces, in the words the item was probably written in, e.g. "牛奶" or "柜子 沙发".'),
      include_closed: bool('true to include done and dropped items.'),
    },
    ['query', 'include_closed'],
  ),
  tool(
    'create_item',
    'Create a new item that the SPEAKER will do (task or reminder), or an unassigned idea. Call this only after checking active_items (and search_items if needed) for an existing item about the same real-world thing; if one exists, update it instead. To have another member do something, call send_request instead.',
    {
      kind: oneOf(['task', 'idea', 'reminder'], 'task = something to do; reminder = only a ping at a time (提醒我8点吃药); idea = no deadline, someday (以后可以去露营).'),
      title: str('Short verb-object title in the speaker\'s words, e.g. "买牛奶", "给外婆打电话". No dates, times or names of the owner in the title.'),
      owner_id: str(`${MEMBER} Omit for the speaker's own task/reminder and for an unassigned idea. Another member only together with explicit_assignment = true.`),
      explicit_assignment: bool('true ONLY when owner_id is another member and the speaker explicitly said to put it on that person\'s list without asking them (记给她 / 算他的 / assign it to him). Otherwise false.'),
      due_date: date(DUE_DATE),
      due_time: str(DUE_TIME),
      details: str('Extra facts the speaker gave (place, amount, phone number, reason). Omit if none.'),
      priority: oneOf(['low', 'normal', 'high'], PRIORITY),
      allow_duplicate: bool('false normally. true only when the speaker clearly wants a second, separate item with the same title as an active one.'),
    },
    ['kind', 'title', 'explicit_assignment', 'priority', 'allow_duplicate'],
  ),
  tool(
    'update_item',
    'Change an existing item: title, kind, owner, due date/time, priority, or progress status. Call this when the speaker corrects, reschedules, re-opens or reports progress on something already on the board (在弄了 / 卡住了 / 改到周六). Do not use it to finish or cancel (complete_item), to answer a request (respond_to_request), or to ask someone else to do it (send_request).',
    {
      item_id: str(ITEM),
      due_change: oneOf(['keep', 'set', 'clear'], '"set" with due_date (and optional due_time) to (re)schedule (this also clears an earlier snooze); "clear" removes the date and time; "keep" leaves them unchanged.'),
      explicit_handover: bool('true ONLY when owner_id is another member and the speaker explicitly hands this item over (这个交给她 / 让他负责这个). Otherwise false.'),
      title: str('New title, only if it changes.'),
      kind: oneOf(['task', 'idea', 'reminder'], 'New kind, only if it changes (e.g. an idea that got a date becomes a task). Requests stay requests.'),
      owner_id: str(`New owner, only if it changes. ${MEMBER} The speaker taking it over themselves, or another member together with explicit_handover = true.`),
      due_date: date(`${DUE_DATE} Only with due_change "set".`),
      due_time: str(`${NEW_DUE_TIME} Only with due_change "set".`),
      priority: oneOf(['low', 'normal', 'high'], 'New priority, only if it changes.'),
      status: oneOf(['open', 'in_progress', 'blocked'], 'New progress status, only if it changes: started (在弄了 / 挂出去了) = in_progress; waiting on something outside the family = blocked; open re-opens a closed task.'),
    },
    ['item_id', 'due_change', 'explicit_handover'],
  ),
  tool(
    'add_note',
    'Attach information to an existing item without changing its fields (where, how much, who called, what was decided, progress details). Call this when the speaker adds detail about something already on the board.',
    { item_id: str(ITEM), text: str('The note in the speaker\'s words, short, e.g. "挂到Facebook上了，80块".') },
    ['item_id', 'text'],
  ),
  tool(
    'send_request',
    'Ask another member to do something. They get a notification and must accept or decline. Call this whenever the speaker wants someone else to do a task (让老公… / 叫她… / 麻烦你… / 你能…吗 addressed to another member). If the thing is already an item on the board, pass existing_item_id instead of creating a new one.',
    {
      to_member_id: str(`${MEMBER} The member being asked. Never the speaker.`),
      title: str('Short verb-object title of what they are asked to do, e.g. "买牛奶", "带孩子出去".'),
      existing_item_id: str(`${ITEM} The existing item this request is about (it is re-sent or turned into the request). Omit to create a new request.`),
      due_date: date(`${DUE_DATE} With existing_item_id: omit both date and time to keep the item's current due.`),
      due_time: str(NEW_DUE_TIME),
      details: str('Context for the other person, written so it reads right to them, e.g. "他九点有个会". Omit if none.'),
      priority: oneOf(['low', 'normal', 'high'], PRIORITY),
      allow_duplicate: bool('false normally; true only when the speaker clearly wants a separate request with the same title as an active item.'),
    },
    ['to_member_id', 'title', 'priority', 'allow_duplicate'],
  ),
  tool(
    'respond_to_request',
    'Accept or decline a pending request that was sent TO the speaker (its owner is the speaker). Call this when the speaker answers it (好的我去 / 可以 / 这周没空 / 做不了 / 算了我去不了); the requester is notified. Only while it is pending: once accepted, backing out is complete_item "dropped" with the reason as the note.',
    {
      item_id: str('Id of the pending request whose owner is the speaker.'),
      response: oneOf(['accept', 'decline'], 'The answer.'),
      message: str('Short message for the requester, only if the speaker gave a reason or a condition.'),
    },
    ['item_id', 'response'],
  ),
  tool(
    'complete_item',
    'Close an item. resolution "done" when it was finished (买好了 / 搞定了 / 弄好了), "dropped" when it is no longer needed (算了 / 不用了 / 取消 / 删掉 / 先不买了). Nothing is ever deleted. Not for a pending request addressed to the speaker (answer it with respond_to_request), and not for cancelling only an extra ping (cancel_reminder). On a request, the result says whether the other person was notified (notified / not_notified).',
    {
      item_id: str(ITEM),
      resolution: oneOf(['done', 'dropped'], 'How it ended.'),
      note: str('Optional short note, e.g. why it was dropped or how it went.'),
    },
    ['item_id', 'resolution'],
  ),
  tool(
    'snooze_item',
    'Snooze an item (晚点再提醒我 / 明天再说 / 周末再弄): it is silenced until the snooze time (its due-time pings are held back) and pinged once then. The due date stays, and extra pings set with set_reminder still fire. If the thing itself moved to a new time (下周再交 / 改到周六), use update_item due_change "set" instead; that also clears the snooze. Use a preset when it fits; "custom" needs until_date and until_time.',
    {
      item_id: str(ITEM),
      preset: oneOf(['tonight', 'tomorrow', 'weekend', 'next_week', 'custom'], 'tonight = 20:00 today (or in 1 hour if later); tomorrow = 09:00 tomorrow; weekend = the next Saturday/Sunday 10:00; next_week = next Monday 09:00; custom = until_date + until_time.'),
      until_date: date('Local date YYYY-MM-DD, only with preset "custom".'),
      until_time: str('Local time HH:MM (24h), only with preset "custom".'),
    },
    ['item_id', 'preset'],
  ),
  tool(
    'set_reminder',
    'Add an extra reminder ping for an EXISTING item at a local date and time (出门前提醒我带护照 / 周日早上提醒她). For a standalone reminder with no item yet, call create_item with kind "reminder" instead.',
    {
      item_id: str(ITEM),
      remind_date: date('Local date YYYY-MM-DD, copied from the calendar.'),
      remind_time: str('Local time HH:MM (24h).'),
      member_ids: { type: 'array', items: { type: 'string' }, description: 'Member ids (m_…) who get the ping. Omit to remind the item\'s owner.' },
    },
    ['item_id', 'remind_date', 'remind_time'],
  ),
  tool(
    'cancel_reminder',
    'Cancel an extra reminder ping set earlier on an item (listed as 另有提醒 in active_items) without closing the item (取消明天早上的提醒 / 那个提醒不用了). Every extra ping on that item at that local date and time is cancelled; the item, its due date and its due-time ping stay. For a kind "reminder" item (the item is the ping) use complete_item "dropped" instead.',
    {
      item_id: str(ITEM),
      remind_date: date('Local date YYYY-MM-DD of the ping, copied from 另有提醒.'),
      remind_time: str('Local time HH:MM (24h) of the ping, copied from 另有提醒.'),
    },
    ['item_id', 'remind_date', 'remind_time'],
  ),
  tool(
    'ask_clarification',
    'Ask the speaker one short question when different readings of the utterance would lead to different changes (two items match, the person or the day is unclear, a key word is garbled). Call it ALONE, never together with other tools in the same response (otherwise nothing in that response is run). It ends your turn; the answer arrives later as a new utterance.',
    {
      question: str('One short question in the speaker\'s language and script.'),
      options: { type: 'array', items: { type: 'string' }, description: '2-4 short tappable answers, e.g. ["卖旧柜子", "修柜门"].' },
    },
    ['question', 'options'],
  ),
]

// ---------------------------------------------------------------------------------------------
// runtime validation (defense in depth: strict mode guarantees the shape, not the formats)

const ItemId = z.string().regex(ITEM_ID_RE, '不是有效的事项 id（应为 i_ 开头，从快照里复制）')
const MemberId = z.string().regex(MEMBER_ID_RE, '不是有效的成员 id（应为 m_ 开头，从 members 里复制）')
const LocalDate = z.iso.date({ message: '日期需要是 YYYY-MM-DD' })
/** "8:30" is padded to "08:30" (there is no pattern on the wire); anything else must be HH:MM. */
const LocalTime = z.preprocess(
  v => (typeof v === 'string' && /^\d:\d{2}$/.test(v.trim()) ? `0${v.trim()}` : typeof v === 'string' ? v.trim() : v),
  z.string().regex(HHMM_RE, '时间需要是 24 小时制 HH:MM，例如 18:30'),
)
const Priority = z.enum(['low', 'normal', 'high'])
const Title = z.string().trim().min(1, '标题不能为空').max(200, '标题太长了（最多 200 个字）')
const Text = (max: number) => z.string().trim().min(1).max(max)

export const SCHEMAS = {
  search_items: z.strictObject({ query: z.string().trim().min(1, '请给一个关键词'), include_closed: z.boolean() }),
  create_item: z.strictObject({
    kind: z.enum(['task', 'idea', 'reminder']),
    title: Title,
    owner_id: MemberId.optional(),
    explicit_assignment: z.boolean(),
    due_date: LocalDate.optional(),
    due_time: LocalTime.optional(),
    details: Text(2000).optional(),
    priority: Priority,
    allow_duplicate: z.boolean(),
  }),
  update_item: z.strictObject({
    item_id: ItemId,
    due_change: z.enum(['keep', 'set', 'clear']),
    explicit_handover: z.boolean(),
    title: Title.optional(),
    kind: z.enum(['task', 'idea', 'reminder']).optional(),
    owner_id: MemberId.optional(),
    due_date: LocalDate.optional(),
    due_time: LocalTime.optional(),
    priority: Priority.optional(),
    status: z.enum(['open', 'in_progress', 'blocked']).optional(),
  }),
  add_note: z.strictObject({ item_id: ItemId, text: Text(2000) }),
  send_request: z.strictObject({
    to_member_id: MemberId,
    title: Title,
    existing_item_id: ItemId.optional(),
    due_date: LocalDate.optional(),
    due_time: LocalTime.optional(),
    details: Text(2000).optional(),
    priority: Priority,
    allow_duplicate: z.boolean(),
  }),
  respond_to_request: z.strictObject({
    item_id: ItemId,
    response: z.enum(['accept', 'decline']),
    message: Text(500).optional(),
  }),
  complete_item: z.strictObject({ item_id: ItemId, resolution: z.enum(['done', 'dropped']), note: Text(500).optional() }),
  snooze_item: z.strictObject({
    item_id: ItemId,
    preset: z.enum(['tonight', 'tomorrow', 'weekend', 'next_week', 'custom']),
    until_date: LocalDate.optional(),
    until_time: LocalTime.optional(),
  }),
  set_reminder: z.strictObject({ item_id: ItemId, remind_date: LocalDate, remind_time: LocalTime, member_ids: z.array(MemberId).optional() }),
  cancel_reminder: z.strictObject({ item_id: ItemId, remind_date: LocalDate, remind_time: LocalTime }),
  ask_clarification: z.strictObject({ question: z.string().trim().min(1), options: z.array(z.string()) }),
} as const

type Schemas = typeof SCHEMAS
export type ToolName = keyof Schemas
export type ParsedCall = { [K in ToolName]: { name: K; input: z.infer<Schemas[K]> } }[ToolName]
/** Every call except ask_clarification (which the loop handles itself). */
export type BoardCall = Exclude<ParsedCall, { name: 'ask_clarification' }>
export type CallOf<K extends ToolName> = Extract<ParsedCall, { name: K }>

/** Enum values may come back with different casing from strict mode; normalize before validating. */
const ENUM_FIELDS = new Set(['kind', 'priority', 'due_change', 'status', 'response', 'resolution', 'preset'])

function normalizeEnums(input: unknown): unknown {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return input
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
    out[k] = ENUM_FIELDS.has(k) && typeof v === 'string' ? v.trim().toLowerCase() : v
  }
  return out
}

export function parseToolCall(name: string, input: unknown): { ok: true; call: ParsedCall } | { ok: false; message: string } {
  if (!Object.hasOwn(SCHEMAS, name)) return { ok: false, message: `Unknown tool "${name}".` }
  const result = SCHEMAS[name as ToolName].safeParse(normalizeEnums(input))
  if (!result.success) return { ok: false, message: z.prettifyError(result.error) }
  return { ok: true, call: { name, input: result.data } as ParsedCall }
}
