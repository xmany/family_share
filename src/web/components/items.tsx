// Item rows (a section's items share one card, hairline between), kind icon, status pill and the accept / decline
// control.

import { useState, type ReactNode } from 'react'
import type { Item, ItemKind, Member } from '../../shared/types'
import { formatInstantZh } from '../../shared/time'
import { dueInfo, isSnoozed } from '../lib/board'
import { STATUS_LABEL, statusTone } from '../lib/labels'
import { Link } from '../lib/router'
import { api, errorMessage } from '../lib/api'
import { mergeItems } from '../lib/store'
import { toast } from '../lib/toast'
import { describeRepeat } from '../../shared/repeat'
import { IconBell, IconCheck, IconClock, IconIdea, IconRepeat, IconRequest, IconSnooze, IconTask } from './Icons'
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

/** One card holding a section's rows. `sky`: the section that waits on me, raised on the evening sky. */
export function ItemList({ sky = false, children }: { sky?: boolean; children: ReactNode }) {
  return <ul className={`${sky ? 'sky sky-dusk' : 'card'} overflow-hidden`}>{children}</ul>
}

export function ItemRow({
  item,
  members,
  meId,
  now,
  tz,
  footer,
  note,
}: {
  item: Item
  members: Map<string, Member>
  meId: string
  now: Date
  tz: string
  /** controls under the row (e.g. 接受 / 做不了) */
  footer?: ReactNode
  /** a line of context under the row */
  note?: string
}) {
  const due = dueInfo(item, now, tz)
  const closed = item.status === 'done' || item.status === 'dropped'
  const overdue = !closed && !!due?.overdue
  const snoozed = !closed && isSnoozed(item, now)
  const owner = item.ownerId ? members.get(item.ownerId) : undefined
  return (
    <li className="item-row">
      <Link to={`/item/${encodeURIComponent(item.id)}`} className="item-row-link">
        <span className="kind-tile" data-done={item.status === 'done' ? '' : undefined}>
          {item.status === 'done' ? <IconCheck size={18} /> : <KindIcon kind={item.kind} size={18} />}
        </span>
        <div className="min-w-0 flex-1">
          <div className={`item-title line-clamp-2 ${closed ? 'font-normal text-muted line-through decoration-faint' : ''}`}>
            {item.title}
          </div>
          <div className="item-meta">
            {item.kind === 'request' && item.requestedBy && (
              <span>
                {nameFor(item.requestedBy, members, meId)} → {nameFor(item.ownerId, members, meId)}
              </span>
            )}
            {due && !closed && (
              <span
                className={`inline-flex items-center gap-1 ${overdue ? 'font-semibold text-danger' : due.today ? 'font-semibold text-accent-strong' : ''}`}
              >
                <IconClock size={14} className="flex-none" />
                <span className="when">{due.label}</span>
                {item.repeat && (
                  <span className="inline-flex items-center gap-0.5 font-normal text-muted" title={describeRepeat(item.repeat)}>
                    <IconRepeat size={13} className="flex-none" />
                    <span className="sr-only">{describeRepeat(item.repeat)}</span>
                  </span>
                )}
              </span>
            )}
            {snoozed && item.snoozedUntil && (
              <span className="inline-flex items-center gap-1">
                <IconSnooze size={14} className="flex-none" />
                推迟到 <span className="when">{formatInstantZh(item.snoozedUntil, now, tz)}</span>
              </span>
            )}
            {closed && item.completedAt && (
              <span>
                <span className="when">{formatInstantZh(item.completedAt, now, tz)}</span> 完成
              </span>
            )}
            <StatusPill item={item} overdue={overdue} />
          </div>
        </div>
        {owner && <Avatar member={owner} size={28} title={owner.name} />}
      </Link>
      {note && <p className="item-row-extra hint -mt-1.5">{note}</p>}
      {footer && <div className="item-row-extra">{footer}</div>}
    </li>
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
          <button type="button" className={`btn flex-1 ${size}`} onClick={() => setMode('idle')} disabled={!!busy}>
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
      <button type="button" className={`btn flex-1 ${size}`} disabled={!!busy} onClick={() => setMode('declining')}>
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
