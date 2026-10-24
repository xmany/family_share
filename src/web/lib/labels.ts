// Chinese labels for domain enums (kept in sync with src/server/domain/describe.ts).

import type { EventType, ItemKind, ItemStatus, MemberRole, Priority } from '../../shared/types'

export const STATUS_LABEL: Record<ItemStatus, string> = {
  open: '待办',
  pending: '待回复',
  accepted: '已接受',
  declined: '做不了',
  in_progress: '进行中',
  blocked: '卡住了',
  done: '完成',
  dropped: '不做了',
}

export const KIND_LABEL: Record<ItemKind, string> = {
  task: '待办',
  request: '请求',
  idea: '想法',
  reminder: '提醒',
}

export const PRIORITY_LABEL: Record<Priority, string> = {
  low: '不急',
  normal: '普通',
  high: '紧急',
}

export const ROLE_LABEL: Record<MemberRole, string> = {
  adult: '大人',
  kid: '孩子',
  relative: '亲友',
}

export const EVENT_LABEL: Partial<Record<EventType, string>> = {
  item_created: '新建',
  item_updated: '修改',
  status_changed: '状态',
  item_reassigned: '换人',
  note_added: '备注',
  request_sent: '请求',
  request_responded: '回复',
  item_completed: '完成',
  item_snoozed: '推迟',
  reminder_set: '提醒',
  reminder_cancelled: '取消提醒',
  undone: '撤销',
}

export type Tone = 'neutral' | 'accent' | 'danger' | 'ok' | 'warn' | 'info'

export function statusTone(status: ItemStatus): Tone {
  switch (status) {
    case 'pending':
      return 'accent'
    case 'accepted':
    case 'in_progress':
      return 'info'
    case 'blocked':
      return 'warn'
    case 'declined':
      return 'danger'
    case 'done':
      return 'ok'
    default:
      return 'neutral'
  }
}

const CJK = /[\u3400-\u9fff\uf900-\ufaff]/

/**
 * Text inside an avatar. Chinese family names often share the first character (老公 / 老婆), so
 * like Chinese chat apps: names of up to 2 characters are shown whole, longer ones by their last
 * two (王小明 → 小明). Other scripts: the first letter.
 */
export function avatarText(name: string): string {
  const chars = Array.from(name.trim())
  if (chars.length === 0) return '?'
  if (CJK.test(chars[0]!)) return chars.length <= 2 ? chars.join('') : chars.slice(-2).join('')
  return chars[0]!.toUpperCase()
}
