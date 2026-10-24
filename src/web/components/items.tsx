// Item card, kind icon, status pill and the accept / decline control.

import { useState, type ReactNode } from 'react'
import type { Item, ItemKind, Member } from '../../shared/types'
import { formatInstantZh } from '../../shared/time'
import { dueInfo, isSnoozed } from '../lib/board'
import { STATUS_LABEL, statusTone } from '../lib/labels'
import { Link } from '../lib/router'
import { api, errorMessage } from '../lib/api'
import { mergeItems } from '../lib/store'
import { toast } from '../lib/toast'
import { IconBell, IconClock, IconIdea, IconRequest, IconSnooze, IconTask } from './Icons'
import { Avatar, Pill } from './ui'

export function KindIcon({ kind, size = 20, className = '' }: { kind: ItemKind; size?: number; className?: string }) {
  const Icon = kind === 'request' ? IconRequest : kind === 'idea' ? IconIdea : kind === 'reminder' ? IconBell : IconTask
  return <Icon size={size} className={className} />
}

export function StatusPill({ item, overdue }: { item: Item; overdue?: boolean }) {
  if (overdue && (item.status === 'open' || item.status === 'accepted' || item.status === 'in_progress'))
    return <Pill tone="danger">已过期</Pill>
  if (item.status === 'open') return null
  return <Pill tone={statusTone(item.status)}>{STATUS_LABEL[item.status]}</Pill>
}

export function nameFor(memberId: string | null, members: Map<string, Member>, meId: string): string {
  if (!memberId) return '没人'
  if (memberId === meId) return '我'
  return members.get(memberId)?.name ?? '家人'
}

export function ItemCard({
  item,
  members,
  meId,
  now,
  tz,
  footer,
}: {
  item: Item
  members: Map<string, Member>
  meId: string
  now: Date
  tz: string
  footer?: ReactNode
}) {
  const due = dueInfo(item, now, tz)
  const closed = item.status === 'done' || item.status === 'dropped'
  const overdue = !closed && !!due?.overdue
  const snoozed = !closed && isSnoozed(item, now)
  const owner = item.ownerId ? members.get(item.ownerId) : undefined
  return (
    <div className="card overflow-hidden">
      <Link to={`/item/${encodeURIComponent(item.id)}`} className="flex items-start gap-3 px-3.5 py-3 active:bg-surface-2">
        <KindIcon kind={item.kind} className={`mt-[3px] flex-none ${closed ? 'text-ok' : 'text-faint'}`} />
        <div className="min-w-0 flex-1">
          <div className={`line-clamp-2 text-[16.5px] leading-snug ${closed ? 'text-muted line-through decoration-faint' : 'font-medium'}`}>
            {item.title}
          </div>
          <div className="mt-1.5 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[13.5px] text-muted">
            {item.kind === 'request' && item.requestedBy && (
              <span>
                {nameFor(item.requestedBy, members, meId)} → {nameFor(item.ownerId, members, meId)}
              </span>
            )}
            {due && !closed && (
              <span className={`inline-flex items-center gap-1 ${overdue ? 'font-semibold text-danger' : due.today ? 'font-semibold text-accent' : ''}`}>
                <IconClock size={14} />
                {due.label}
              </span>
            )}
            {snoozed && item.snoozedUntil && (
              <span className="inline-flex items-center gap-1">
                <IconSnooze size={14} />
                推迟到 {formatInstantZh(item.snoozedUntil, now, tz)}
              </span>
            )}
            {closed && item.completedAt && <span>{formatInstantZh(item.completedAt, now, tz)} 完成</span>}
            <StatusPill item={item} overdue={overdue} />
          </div>
        </div>
        {owner && <Avatar member={owner} size={28} title={owner.name} />}
      </Link>
      {footer && <div className="border-t border-line px-3.5 py-2.5">{footer}</div>}
    </div>
  )
}

/**
 * 接受 / 做不了. 做不了 opens a small inline input for an optional reason.
 * Handlers are injected so the signed-link page can use its token route.
 */
export function RespondControl({
  onAccept,
  onDecline,
  large = false,
}: {
  onAccept: () => Promise<void>
  onDecline: (message?: string) => Promise<void>
  large?: boolean
}) {
  const [mode, setMode] = useState<'idle' | 'declining'>('idle')
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState<null | 'accept' | 'decline'>(null)
  const size = large ? 'btn-lg' : ''

  const run = async (which: 'accept' | 'decline') => {
    setBusy(which)
    try {
      if (which === 'accept') await onAccept()
      else await onDecline(reason.trim() || undefined)
      setMode('idle')
      setReason('')
    } catch (e) {
      toast(errorMessage(e), 'danger')
    } finally {
      setBusy(null)
    }
  }

  if (mode === 'declining') {
    return (
      <form
        className="flex flex-col gap-2"
        onSubmit={e => {
          e.preventDefault()
          void run('decline')
        }}
      >
        <input
          className="input"
          autoFocus
          maxLength={200}
          aria-label="做不了的原因（可以不填）"
          placeholder="说一下原因（可以不填）"
          value={reason}
          onChange={e => setReason(e.target.value)}
          enterKeyHint="send"
        />
        <div className="flex gap-2">
          <button type="button" className={`btn btn-outline flex-1 ${size}`} onClick={() => setMode('idle')} disabled={!!busy}>
            取消
          </button>
          <button type="submit" className={`btn btn-danger flex-1 ${size}`} disabled={!!busy}>
            {busy === 'decline' ? '发送中…' : '确定做不了'}
          </button>
        </div>
      </form>
    )
  }
  return (
    <div className="flex gap-2">
      <button type="button" className={`btn btn-primary flex-1 ${size}`} disabled={!!busy} onClick={() => void run('accept')}>
        {busy === 'accept' ? '处理中…' : '接受'}
      </button>
      <button type="button" className={`btn btn-outline flex-1 ${size}`} disabled={!!busy} onClick={() => setMode('declining')}>
        做不了
      </button>
    </div>
  )
}

/** RespondControl wired to the session API (board + item pages). */
export function RespondButtons({ item, large, onChanged }: { item: Item; large?: boolean; onChanged?: (item: Item) => void }) {
  return (
    <RespondControl
      large={large}
      onAccept={async () => {
        const { item: updated } = await api.respond(item.id, { response: 'accept' })
        mergeItems([updated])
        onChanged?.(updated)
        toast('已接受，已告诉对方', 'ok')
      }}
      onDecline={async message => {
        const { item: updated } = await api.respond(item.id, message ? { response: 'decline', message } : { response: 'decline' })
        mergeItems([updated])
        onChanged?.(updated)
        toast('已告诉对方你做不了')
      }}
    />
  )
}
