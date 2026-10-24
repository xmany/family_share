// Deterministic Simplified-Chinese text for event summaries, labels and notification titles/bodies.
// Pure functions: every relative label ("今天 / 明天 / 周六 10/24") takes an explicit reference instant.

import type { Item, ItemKind, ItemStatus, Member, NotificationAction, Priority } from '../../shared/types'
import { formatDateZh, formatInstantZh } from '../time'

export const STATUS_LABEL_ZH: Record<ItemStatus, string> = {
  open: '待办',
  pending: '待回复',
  accepted: '已接受',
  declined: '做不了',
  in_progress: '进行中',
  blocked: '卡住了',
  done: '完成',
  dropped: '不做了',
}

export const KIND_LABEL_ZH: Record<ItemKind, string> = {
  task: '待办',
  request: '请求',
  idea: '想法',
  reminder: '提醒',
}

export const PRIORITY_LABEL_ZH: Record<Priority, string> = {
  low: '低',
  normal: '普通',
  high: '高',
}

export const ACTION_TITLE_ZH: Record<NotificationAction['action'], string> = {
  accept: '接受',
  decline: '做不了',
  done: '完成',
  snooze_tonight: '今晚再说',
  snooze_tomorrow: '明天再说',
  open: '查看',
}

export const NOTIFICATION_TITLE_MAX = 40
export const NOTIFICATION_BODY_MAX = 120

export function statusLabel(status: ItemStatus): string {
  return STATUS_LABEL_ZH[status]
}

export function kindLabel(kind: ItemKind): string {
  return KIND_LABEL_ZH[kind]
}

export function actions(...names: NotificationAction['action'][]): NotificationAction[] {
  return names.map(action => ({ action, title: ACTION_TITLE_ZH[action] }))
}

/** Truncates to at most `max` characters (code points), ending with "…" when cut. */
export function clip(text: string, max: number): string {
  const chars = Array.from(text.replace(/\s+/g, ' ').trim())
  if (chars.length <= max) return chars.join('')
  return chars.slice(0, Math.max(0, max - 1)).join('') + '…'
}

/** "今天 08:30" for dueAt, "明天" for dueDate, null when undated. `ref` is the instant the label is read at. */
export function dueLabel(item: Pick<Item, 'dueAt' | 'dueDate'>, ref: Date, tz: string): string | null {
  if (item.dueAt) return formatInstantZh(item.dueAt, ref, tz)
  if (item.dueDate) return formatDateZh(item.dueDate, ref, tz)
  return null
}

/** Name lookup that never leaks ids: unknown/null members become a neutral word. */
export type NameOf = (memberId: string | null | undefined) => string

export function nameLookup(members: readonly Member[]): NameOf {
  const byId = new Map(members.map(m => [m.id, m.name]))
  return id => (id ? (byId.get(id) ?? '家人') : '系统')
}

const withDue = (s: string, due: string | null) => (due ? `${s}（${due}）` : s)

// ---------------------------------------------------------------------------------------------
// Event summaries (shown in the chat "改动" card and item history)

export interface SummaryEnv {
  now: Date
  tz: string
  nameOf: NameOf
}

/** "新建待办：买地毯（明天）" / "新建待办 → 老婆：买地毯" / "新建想法：去日本玩" */
export function summarizeCreated(item: Item, actorMemberId: string | null, env: SummaryEnv): string {
  const toOther = item.ownerId && item.ownerId !== actorMemberId ? ` → ${env.nameOf(item.ownerId)}` : ''
  return clip(withDue(`新建${kindLabel(item.kind)}${toOther}：${item.title}`, dueLabel(item, env.now, env.tz)), 120)
}

/** "请求 → 老婆：带孩子出去（周六 08:30）"; re-sends start with "再次请求". */
export function summarizeRequestSent(item: Item, round: number, env: SummaryEnv): string {
  const head = round > 1 ? '再次请求' : '请求'
  return clip(withDue(`${head} → ${env.nameOf(item.ownerId)}：${item.title}`, dueLabel(item, env.now, env.tz)), 120)
}

/** "老婆接受了：带孩子出去" / "老婆做不了：带孩子出去（周六有事）" */
export function summarizeResponded(item: Item, response: 'accept' | 'decline', message: string | null, env: SummaryEnv): string {
  const verb = response === 'accept' ? '接受了' : '做不了'
  const base = `${env.nameOf(item.ownerId)}${verb}：${item.title}`
  return clip(message ? `${base}（${clip(message, 30)}）` : base, 120)
}

/** "卖旧柜子：待办 → 进行中"; done / dropped read as "完成：买地毯" / "不做了：买地毯". */
export function summarizeStatus(title: string, from: ItemStatus, to: ItemStatus): string {
  if (to === 'done') return clip(`完成：${title}`, 120)
  if (to === 'dropped') return clip(`不做了：${title}`, 120)
  return clip(`${title}：${statusLabel(from)} → ${statusLabel(to)}`, 120)
}

/** "转给老婆：买地毯" / "买地毯：不指定负责人" */
export function summarizeReassigned(title: string, toOwnerId: string | null, env: SummaryEnv): string {
  if (!toOwnerId) return clip(`${title}：不指定负责人`, 120)
  return clip(`转给${env.nameOf(toOwnerId)}：${title}`, 120)
}

/** "推迟：卖旧柜子 → 明天 09:00" */
export function summarizeSnoozed(title: string, until: Date, env: SummaryEnv): string {
  return clip(`推迟：${title} → ${formatInstantZh(until, env.now, env.tz)}`, 120)
}

/** "备注（卖旧柜子）：挂出去了，80块" */
export function summarizeNote(title: string, text: string): string {
  return clip(`备注（${clip(title, 30)}）：${text}`, 80)
}

/** "设提醒 → 老婆：买牛奶（明天 09:00）" */
export function summarizeReminderSet(memberId: string, message: string, fireAt: Date, env: SummaryEnv): string {
  return clip(`设提醒 → ${env.nameOf(memberId)}：${message}（${formatInstantZh(fireAt, env.now, env.tz)}）`, 120)
}

/** "取消提醒：买牛奶（明天 09:00）" */
export function summarizeReminderCancelled(message: string, fireAt: Date, env: SummaryEnv): string {
  return clip(`取消提醒：${message}（${formatInstantZh(fireAt, env.now, env.tz)}）`, 120)
}

/** "撤销：明天早上你能带孩子出去吗" */
export function summarizeUndone(utteranceText: string, changeCount: number): string {
  const text = clip(utteranceText, 30)
  return text ? `撤销：${text}` : `撤销了 ${changeCount} 项改动`
}

export interface FieldChanges {
  title?: { from: string; to: string }
  details?: { to: string | null }
  due?: { dueAt: string | null; dueDate: string | null }
  priority?: Priority
  kind?: ItemKind
  tags?: string[]
  parentChanged?: boolean
}

/** "卖旧柜子：时间 → 周日 10:00，优先级 → 高" */
export function summarizeFieldsUpdated(title: string, c: FieldChanges, env: SummaryEnv): string {
  const parts: string[] = []
  if (c.title) parts.push(`改名（原：${clip(c.title.from, 20)}）`)
  if (c.kind) parts.push(`改为${kindLabel(c.kind)}`)
  if (c.due) {
    if (c.due.dueAt) parts.push(`时间 → ${formatInstantZh(c.due.dueAt, env.now, env.tz)}`)
    else if (c.due.dueDate) parts.push(`日期 → ${formatDateZh(c.due.dueDate, env.now, env.tz)}`)
    else parts.push('去掉时间')
  }
  if (c.details) parts.push(c.details.to ? '更新说明' : '清空说明')
  if (c.priority) parts.push(`优先级 → ${PRIORITY_LABEL_ZH[c.priority]}`)
  if (c.tags) parts.push(c.tags.length ? `标签 → ${c.tags.join('、')}` : '清空标签')
  if (c.parentChanged) parts.push('调整归属')
  return clip(`${title}：${parts.join('，') || '修改'}`, 120)
}

// ---------------------------------------------------------------------------------------------
// Notification texts (titles <= 40 chars, bodies <= 120 chars). `ref` = the instant the
// notification will be read: its fire time when planned, and the delivery instant when the scheduler
// re-renders an item-bound row just before sending it (policy.ts textAtDelivery), so "今天 / 明天" are
// right even after a quiet-hours deferral, a retry or downtime.

export interface NotificationText {
  title: string
  body: string
}

function text(title: string, bodyParts: (string | null | undefined)[], fallback: string): NotificationText {
  const body = bodyParts.filter((p): p is string => !!p && p.trim() !== '').join(' · ')
  return { title: clip(title, NOTIFICATION_TITLE_MAX), body: clip(body || fallback, NOTIFICATION_BODY_MAX) }
}

const firstLine = (s: string | null) => (s ? (s.split('\n')[0] ?? '').trim() || null : null)

/** title "老公请你：带孩子出去", body "周六 08:30 · 他九点有个会" */
export function requestNewText(item: Item, requesterName: string, ref: Date, tz: string): NotificationText {
  return text(`${requesterName}请你：${item.title}`, [dueLabel(item, ref, tz), firstLine(item.details)], '接受还是做不了？')
}

/** title "还没回复：带孩子出去", body "老公在等你回复 · 周六 08:30" */
export function requestFollowupText(item: Item, requesterName: string, ref: Date, tz: string): NotificationText {
  return text(`还没回复：${item.title}`, [`${requesterName}在等你回复`, dueLabel(item, ref, tz)], '')
}

/** (to requester) title "老婆还没回复：带孩子出去" */
export function requestNoreplyText(item: Item, ownerName: string, ref: Date, tz: string): NotificationText {
  return text(`${ownerName}还没回复：${item.title}`, [dueLabel(item, ref, tz), '要不要当面问一下，或者换个安排？'], '')
}

/** (to requester) "老婆接受了：带孩子出去" / "老婆做不了：…" / "老婆完成了：…" */
export function requestAnsweredText(
  item: Item,
  response: 'accept' | 'decline' | 'done',
  responderName: string,
  message: string | null,
  ref: Date,
  tz: string,
): NotificationText {
  const verb = response === 'accept' ? '接受了' : response === 'decline' ? '做不了' : '完成了'
  const fallback = response === 'decline' ? '要不要换个安排？' : '点开看看'
  return text(`${responderName}${verb}：${item.title}`, [message, response === 'done' ? null : dueLabel(item, ref, tz)], fallback)
}

/**
 * A request closed as dropped, to the other side: "老婆不做了：带孩子出去 · 去不了了" (the owner backs out, to the
 * requester) / "老公取消了：买牛奶 · 我自己买吧" (the requester takes it back, or a third person drops it).
 * No due label: the text is not re-rendered at delivery (it has no "今天 / 明天" to go stale).
 */
export function requestDroppedText(
  item: Item,
  actorName: string,
  opts: { byOwner: boolean; toOwner: boolean; message: string | null },
): NotificationText {
  const verb = opts.byOwner ? '不做了' : '取消了'
  return text(`${actorName}${verb}：${item.title}`, [opts.message], opts.toOwner ? '不用做了' : '要不要换个安排？')
}

/** title "老公交给你：买地毯" */
export function assignedText(item: Item, actorName: string | null, ref: Date, tz: string): NotificationText {
  const title = actorName ? `${actorName}交给你：${item.title}` : `新事项交给你：${item.title}`
  return text(title, [dueLabel(item, ref, tz), firstLine(item.details)], '点开看看')
}

/** 60 min before dueAt: title "快到时间：买地毯", body "今天 15:00（1 小时后）" */
export function dueSoonText(item: Item, ref: Date, tz: string): NotificationText {
  const due = item.dueAt ? `${formatInstantZh(item.dueAt, ref, tz)}（1 小时后）` : null
  return text(`快到时间：${item.title}`, [due, firstLine(item.details)], '快到时间了')
}

/** 20:00 the evening before an early dueAt: title "明早：带孩子出去", body "明天 08:30 · 早点休息" */
export function dueEveningText(item: Item, ref: Date, tz: string): NotificationText {
  const due = item.dueAt ? formatInstantZh(item.dueAt, ref, tz) : null
  return text(`明早：${item.title}`, [due, firstLine(item.details)], '明天一早的事，别忘了')
}

/** 09:00 on dueDate: title "今天要做：买地毯" */
export function dueDayText(item: Item, ref: Date, tz: string): NotificationText {
  return text(`今天要做：${item.title}`, [item.dueDate ? formatDateZh(item.dueDate, ref, tz) : null, firstLine(item.details)], '今天')
}

/** kind reminder at dueAt: title "提醒：交水费", body "今天 15:00" */
export function reminderItemText(item: Item, ref: Date, tz: string): NotificationText {
  return text(`提醒：${item.title}`, [dueLabel(item, ref, tz), firstLine(item.details)], '时间到了')
}

/** setReminder / createItem.remindAt: title "提醒：<message>", body item title or the time */
export function explicitReminderText(message: string, itemTitle: string | null, fireAt: Date, tz: string): NotificationText {
  const time = formatInstantZh(fireAt, fireAt, tz)
  return text(`提醒：${message}`, [itemTitle && itemTitle !== message ? itemTitle : null, time], time)
}

/** snooze end: title "该处理了：卖旧柜子", body "之前推迟到现在 · 已推迟 2 次" */
export function snoozeText(item: Item, ref: Date, tz: string): NotificationText {
  return text(
    `该处理了：${item.title}`,
    ['之前推迟到现在', item.snoozeCount > 1 ? `已推迟 ${item.snoozeCount} 次` : null, dueLabel(item, ref, tz)],
    '',
  )
}
