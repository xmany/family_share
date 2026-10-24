// 事项: every field, notes, history, and the manual buttons (完成 / 推迟 / 接受 / 做不了 / 编辑 / 加备注 / 分享).

import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import type { ItemDetailResponse, UpdateItemBody } from '../../shared/api'
import type { Item, Member } from '../../shared/types'
import {
  formatInstantZh,
  localDate,
  localTime,
  resolveSnoozePreset,
  zonedToUtc,
  type SnoozePreset,
} from '../../shared/time'
import { api, errorMessage, isApiError } from '../lib/api'
import { dueInfo, isActive, isSnoozed } from '../lib/board'
import { KIND_LABEL, PRIORITY_LABEL, ROLE_LABEL } from '../lib/labels'
import { mergeItems, useApp, useNow } from '../lib/store'
import { shareOrCopy, toast } from '../lib/toast'
import { KindIcon, RespondButtons, StatusPill, nameFor } from '../components/items'
import { IconCheck, IconEdit, IconNote, IconShare, IconSnooze } from '../components/Icons'
import { Avatar, ErrorNote, LoadingScreen, PageHeader, Pill } from '../components/ui'

const SNOOZE_PRESETS: Array<{ preset: SnoozePreset; label: string }> = [
  { preset: 'tonight', label: '今晚' },
  { preset: 'tomorrow', label: '明天' },
  { preset: 'weekend', label: '周末' },
  { preset: 'next_week', label: '下周' },
]

function newer(a: Item | undefined, b: Item | undefined): Item | undefined {
  if (!a) return b
  if (!b) return a
  return a.updatedAt >= b.updatedAt ? a : b
}

export function ItemPage({ id }: { id: string }) {
  const app = useApp()
  const board = app.board
  const nowD = useNow()
  const tz = board?.family.timezone ?? 'UTC'
  const meId = board?.me.id ?? ''
  const members = useMemo(() => new Map((board?.members ?? []).map(m => [m.id, m])), [board?.members])
  const boardItem = board?.items.find(i => i.id === id)

  const [detail, setDetail] = useState<ItemDetailResponse | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [panel, setPanel] = useState<null | 'snooze' | 'edit' | 'note'>(null)

  const load = useCallback(async () => {
    try {
      const d = await api.item(id)
      setDetail(d)
      setError(null)
    } catch (e) {
      setError(isApiError(e) && e.status === 404 ? '找不到这件事，可能已经被删除了' : errorMessage(e))
    }
  }, [id])

  // refetch when the board says this item changed (SSE → board refresh)
  const boardStamp = boardItem ? `${boardItem.updatedAt}|${boardItem.lastActivityAt}` : ''
  useEffect(() => {
    void load()
  }, [load, boardStamp])

  const item = newer(boardItem, detail?.item)

  if (!item) {
    if (error) return (
      <div className="page">
        <PageHeader title="事项" back="/board" />
        <ErrorNote message={error} onRetry={() => void load()} />
      </div>
    )
    return (
      <div className="page">
        <PageHeader title="事项" back="/board" />
        <LoadingScreen />
      </div>
    )
  }

  const due = dueInfo(item, nowD, tz)
  const active = isActive(item)
  const closed = !active
  const overdue = active && !!due?.overdue
  const isRequest = item.kind === 'request'
  const pendingForMe = isRequest && item.status === 'pending' && item.ownerId === meId
  const declinedMine = isRequest && item.status === 'declined' && item.requestedBy === meId
  const waitingOnThem = isRequest && item.status === 'pending' && item.requestedBy === meId && item.ownerId !== meId
  const owner = item.ownerId ? members.get(item.ownerId) : undefined
  const canWork = active && !(isRequest && (item.status === 'pending' || item.status === 'declined'))

  const act = async (key: string, fn: () => Promise<{ item: Item }>, ok: string) => {
    setBusy(key)
    try {
      const { item: updated } = await fn()
      mergeItems([updated])
      setDetail(d => (d ? { ...d, item: updated } : d))
      setPanel(null)
      toast(ok, 'ok')
      if (!boardItem) void load() // otherwise the board change triggers the refetch
    } catch (e) {
      toast(errorMessage(e), 'danger')
    } finally {
      setBusy(null)
    }
  }

  const share = () => {
    const url = `${window.location.origin}/item/${encodeURIComponent(item.id)}`
    const when = due ? `（${due.label}）` : ''
    void shareOrCopy({ title: '家庭同步', text: `${item.title}${when}`, url })
  }

  return (
    <div className="page">
      <PageHeader
        title={KIND_LABEL[item.kind]}
        back="/board"
        right={
          <button type="button" className="icon-btn" aria-label="分享" onClick={share}>
            <IconShare size={21} />
          </button>
        }
      />
      <div className="page-pad flex flex-col gap-4">
        {/* summary */}
        <div className="card p-4">
          <div className="flex items-center gap-2 text-[13.5px] text-muted">
            <KindIcon kind={item.kind} size={17} />
            <span>{KIND_LABEL[item.kind]}</span>
            <StatusPill item={item} overdue={overdue} />
            {item.priority !== 'normal' && <Pill tone={item.priority === 'high' ? 'danger' : 'neutral'}>{PRIORITY_LABEL[item.priority]}</Pill>}
          </div>
          <h2 className={`mt-2 text-[22px] leading-snug font-bold ${closed ? 'text-muted line-through decoration-faint' : ''}`}>
            {item.title}
          </h2>

          <dl className="mt-3 flex flex-col gap-2 text-[15px]">
            <Field label="负责">
              {owner ? (
                <span className="inline-flex items-center gap-2">
                  <Avatar member={owner} size={24} />
                  {nameFor(item.ownerId, members, meId)}
                </span>
              ) : (
                <span className="text-muted">没人负责</span>
              )}
            </Field>
            {isRequest && item.requestedBy && (
              <Field label="谁请的">
                <span className="inline-flex items-center gap-2">
                  <Avatar member={members.get(item.requestedBy)} size={24} />
                  {nameFor(item.requestedBy, members, meId)}
                </span>
              </Field>
            )}
            {due && (
              <Field label="时间">
                <span className={overdue ? 'font-semibold text-danger' : due.today ? 'font-semibold text-accent' : ''}>
                  {due.label}
                  {overdue && '（已过期）'}
                </span>
              </Field>
            )}
            {active && isSnoozed(item, nowD) && item.snoozedUntil && (
              <Field label="推迟到">{formatInstantZh(item.snoozedUntil, nowD, tz)}</Field>
            )}
            {active && item.remindAt && <Field label="下次提醒">{formatInstantZh(item.remindAt, nowD, tz)}</Field>}
            {item.completedAt && <Field label="完成于">{formatInstantZh(item.completedAt, nowD, tz)}</Field>}
            <Field label="创建">
              <span className="text-muted">
                {nameFor(item.createdBy, members, meId)} · {formatInstantZh(item.createdAt, nowD, tz)}
              </span>
            </Field>
          </dl>

          {item.details && <p className="mt-3 rounded-xl bg-surface-2 px-3 py-2.5 text-[15px] whitespace-pre-wrap">{item.details}</p>}
        </div>

        {/* primary actions */}
        {pendingForMe && (
          <div className="card flex flex-col gap-3 p-4">
            <p className="text-[15px]">{nameFor(item.requestedBy, members, meId)}在等你的回复</p>
            <RespondButtons item={item} large onChanged={() => void load()} />
          </div>
        )}

        {declinedMine && (
          <div className="card flex flex-col gap-3 p-4">
            <p className="text-[15px]">{nameFor(item.ownerId, members, meId)}说做不了。要怎么办？</p>
            <div className="flex gap-2">
              <button
                type="button"
                className="btn btn-primary flex-1"
                disabled={!!busy}
                onClick={() => void act('resend', () => api.updateItem(item.id, { status: 'pending' }), '已重新发送')}
              >
                重新请求
              </button>
              <button
                type="button"
                className="btn btn-outline flex-1"
                disabled={!!busy}
                onClick={() => void act('drop', () => api.updateItem(item.id, { status: 'dropped' }), '好的，不做了')}
              >
                不需要了
              </button>
            </div>
          </div>
        )}

        {waitingOnThem && (
          <div className="card flex items-center justify-between gap-3 p-4">
            <p className="min-w-0 text-[15px]">在等{nameFor(item.ownerId, members, meId)}回复</p>
            <DropButton
              label="不需要了"
              disabled={!!busy}
              onConfirm={() => void act('drop', () => api.updateItem(item.id, { status: 'dropped' }), '好的，已经撤回')}
            />
          </div>
        )}

        {canWork && (
          <div className="flex flex-col gap-2.5">
            <div className="flex gap-2.5">
              <button
                type="button"
                className="btn btn-primary btn-lg flex-1"
                disabled={!!busy}
                onClick={() => void act('done', () => api.complete(item.id, {}), '完成了，辛苦啦')}
              >
                <IconCheck size={20} />
                {busy === 'done' ? '处理中…' : '完成'}
              </button>
              {item.kind !== 'idea' && (
                <button
                  type="button"
                  className={`btn btn-lg flex-1 ${panel === 'snooze' ? 'btn-outline' : ''}`}
                  disabled={!!busy}
                  onClick={() => setPanel(p => (p === 'snooze' ? null : 'snooze'))}
                >
                  <IconSnooze size={20} />
                  推迟
                </button>
              )}
            </div>
            {panel === 'snooze' && (
              <div className="grid grid-cols-2 gap-2">
                {SNOOZE_PRESETS.map(({ preset, label }) => (
                  <button
                    key={preset}
                    type="button"
                    className="btn flex-col gap-0 py-2"
                    disabled={!!busy}
                    onClick={() =>
                      void act(`snooze_${preset}`, () => api.snooze(item.id, { preset }), `已推迟到${label}`)
                    }
                  >
                    <span>{label}</span>
                    <span className="text-[12.5px] font-normal text-muted">
                      {formatInstantZh(resolveSnoozePreset(preset, nowD, tz), nowD, tz)}
                    </span>
                  </button>
                ))}
              </div>
            )}
          </div>
        )}

        {closed && !isRequest && (
          <button
            type="button"
            className="btn btn-outline"
            disabled={!!busy}
            onClick={() => void act('reopen', () => api.updateItem(item.id, { status: 'open' }), '已重新打开')}
          >
            重新打开
          </button>
        )}

        {/* secondary actions */}
        <div className="flex gap-2">
          <button type="button" className="btn btn-sm flex-1" onClick={() => setPanel(p => (p === 'edit' ? null : 'edit'))}>
            <IconEdit size={16} />
            编辑
          </button>
          <button type="button" className="btn btn-sm flex-1" onClick={() => setPanel(p => (p === 'note' ? null : 'note'))}>
            <IconNote size={16} />
            加备注
          </button>
          <button type="button" className="btn btn-sm flex-1" onClick={share}>
            <IconShare size={16} />
            分享
          </button>
        </div>

        {panel === 'edit' && (
          <EditForm
            item={item}
            members={board?.members ?? []}
            tz={tz}
            busy={busy === 'edit'}
            onCancel={() => setPanel(null)}
            onSave={body => void act('edit', () => api.updateItem(item.id, body), '已保存')}
          />
        )}
        {panel === 'note' && (
          <NoteForm
            busy={busy === 'note'}
            onCancel={() => setPanel(null)}
            onSave={text => void act('note', () => api.addNote(item.id, { text }), '备注已添加')}
          />
        )}

        {canWork && (
          <div className="flex flex-wrap gap-2">
            {item.status !== 'in_progress' && (
              <button
                type="button"
                className="btn btn-sm btn-ghost"
                disabled={!!busy}
                onClick={() => void act('start', () => api.updateItem(item.id, { status: 'in_progress' }), '已标记为进行中')}
              >
                开始做了
              </button>
            )}
            {item.status !== 'blocked' && (
              <button
                type="button"
                className="btn btn-sm btn-ghost"
                disabled={!!busy}
                onClick={() => void act('block', () => api.updateItem(item.id, { status: 'blocked' }), '已标记为卡住了')}
              >
                卡住了
              </button>
            )}
            <DropButton
              disabled={!!busy}
              onConfirm={() => void act('drop', () => api.updateItem(item.id, { status: 'dropped' }), '好的，不做了')}
            />
          </div>
        )}

        {/* notes */}
        {detail && detail.notes.length > 0 && (
          <section>
            <h3 className="section-title mt-2">备注</h3>
            <div className="card">
              {[...detail.notes]
                .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
                .map(n => (
                  <div key={n.id} className="list-row items-start">
                    <Avatar member={n.memberId ? members.get(n.memberId) : undefined} size={26} />
                    <div className="min-w-0 flex-1">
                      <p className="text-[15px] whitespace-pre-wrap">{n.text}</p>
                      <p className="mt-0.5 text-[12.5px] text-faint">
                        {nameFor(n.memberId, members, meId)}
                        {n.authorType === 'ai' ? '（通过对话）' : ''} · {formatInstantZh(n.createdAt, nowD, tz)}
                      </p>
                    </div>
                  </div>
                ))}
            </div>
          </section>
        )}

        {/* upcoming notifications */}
        {detail && detail.notifications.some(n => n.status === 'scheduled') && (
          <section>
            <h3 className="section-title mt-2">接下来的提醒</h3>
            <div className="card">
              {detail.notifications
                .filter(n => n.status === 'scheduled')
                .sort((a, b) => a.fireAt.localeCompare(b.fireAt))
                .map(n => (
                  <div key={n.id} className="list-row">
                    <Avatar member={members.get(n.memberId)} size={26} />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-[15px]">{n.title}</p>
                      <p className="text-[12.5px] text-faint">
                        {formatInstantZh(n.fireAt, nowD, tz)} 提醒{nameFor(n.memberId, members, meId)}
                      </p>
                    </div>
                  </div>
                ))}
            </div>
          </section>
        )}

        {/* history */}
        {detail && detail.events.length > 0 && (
          <section>
            <h3 className="section-title mt-2">记录</h3>
            <div className="card">
              {[...detail.events]
                .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id - a.id)
                .map(ev => (
                  <div key={ev.id} className="list-row items-start">
                    {ev.memberId ? (
                      <Avatar member={members.get(ev.memberId)} size={26} />
                    ) : (
                      <span className="avatar bg-surface-2 text-[12px] text-muted" style={{ width: 26, height: 26 }}>
                        系
                      </span>
                    )}
                    <div className="min-w-0 flex-1">
                      <p className={`text-[15px] ${ev.undone ? 'text-muted line-through' : ''}`}>{ev.summary}</p>
                      <p className="mt-0.5 text-[12.5px] text-faint">
                        {ev.memberId ? nameFor(ev.memberId, members, meId) : '系统'}
                        {ev.actorType === 'ai' ? '（通过对话）' : ''} · {formatInstantZh(ev.createdAt, nowD, tz)}
                        {ev.undone && ' · 已撤销'}
                      </p>
                    </div>
                  </div>
                ))}
            </div>
          </section>
        )}
        {!detail && !error && <p className="text-center text-[14px] text-muted">正在加载记录…</p>}
        {error && detail === null && <p className="text-center text-[14px] text-danger">{error}</p>}
      </div>
    </div>
  )
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-center gap-3">
      <dt className="w-16 flex-none text-[14px] text-muted">{label}</dt>
      <dd className="min-w-0 flex-1">{children}</dd>
    </div>
  )
}

function DropButton({ disabled, onConfirm, label = '不做了' }: { disabled: boolean; onConfirm: () => void; label?: string }) {
  const [confirming, setConfirming] = useState(false)
  useEffect(() => {
    if (!confirming) return
    const t = setTimeout(() => setConfirming(false), 4000)
    return () => clearTimeout(t)
  }, [confirming])
  return (
    <button
      type="button"
      className={`btn btn-sm ${confirming ? 'btn-danger' : 'btn-ghost'}`}
      disabled={disabled}
      onClick={() => (confirming ? onConfirm() : setConfirming(true))}
    >
      {confirming ? `确定${label}？` : label}
    </button>
  )
}

function EditForm({
  item,
  members,
  tz,
  busy,
  onCancel,
  onSave,
}: {
  item: Item
  members: Member[]
  tz: string
  busy: boolean
  onCancel: () => void
  onSave: (body: UpdateItemBody) => void
}) {
  const [title, setTitle] = useState(item.title)
  const [ownerId, setOwnerId] = useState(item.ownerId ?? '')
  const [date, setDate] = useState(item.dueAt ? localDate(new Date(item.dueAt), tz) : (item.dueDate ?? ''))
  const [time, setTime] = useState(item.dueAt ? localTime(new Date(item.dueAt), tz) : '')
  const [details, setDetails] = useState(item.details ?? '')
  const isRequest = item.kind === 'request'
  const isIdea = item.kind === 'idea'
  const deviceTz = Intl.DateTimeFormat().resolvedOptions().timeZone

  const save = () => {
    const t = title.trim()
    if (!t) {
      toast('标题不能为空', 'danger')
      return
    }
    if (time && !date) {
      toast('请先选日期', 'danger')
      return
    }
    const body: UpdateItemBody = {}
    if (t !== item.title) body.title = t
    const d = details.trim() || null
    if (d !== (item.details ?? null)) body.details = d
    if (!isRequest && ownerId !== (item.ownerId ?? '')) body.ownerId = ownerId || null
    if (!isIdea) {
      let newAt: string | null = null
      let newDate: string | null = null
      if (date && time) {
        try {
          // some pickers report seconds ("08:30:00"); the family-timezone conversion wants HH:MM
          newAt = zonedToUtc(date, time.slice(0, 5), tz).toISOString()
        } catch {
          toast('时间格式不对', 'danger')
          return
        }
      } else if (date) newDate = date
      const minute = (iso: string | null) => (iso ? Math.floor(new Date(iso).getTime() / 60_000) : null)
      const changed = minute(newAt) !== minute(item.dueAt) || newDate !== (item.dueDate ?? null)
      if (changed) {
        if (newAt) body.dueAt = newAt
        else if (newDate) body.dueDate = newDate
        else {
          body.dueAt = null
          body.dueDate = null
        }
      }
    }
    if (Object.keys(body).length === 0) {
      onCancel()
      return
    }
    onSave(body)
  }

  return (
    <form
      className="card flex flex-col gap-3.5 p-4"
      onSubmit={e => {
        e.preventDefault()
        save()
      }}
    >
      <div>
        <label className="label" htmlFor="edit-title">
          标题
        </label>
        <input id="edit-title" className="input" value={title} maxLength={200} onChange={e => setTitle(e.target.value)} />
      </div>
      <div>
        <label className="label" htmlFor="edit-owner">
          谁负责
        </label>
        <select
          id="edit-owner"
          className="input"
          value={ownerId}
          disabled={isRequest}
          onChange={e => setOwnerId(e.target.value)}
        >
          {(isIdea || !item.ownerId) && <option value="">没人负责</option>}
          {members.map(m => (
            <option key={m.id} value={m.id}>
              {m.name}（{ROLE_LABEL[m.role]}）
            </option>
          ))}
        </select>
        {isRequest && <p className="mt-1 text-[13px] text-muted">请求的负责人不能直接改；可以在对话里说「这个交给…」。</p>}
        {!isRequest && ownerId && ownerId !== (item.ownerId ?? '') && (
          <p className="mt-1 text-[13px] text-muted">保存后会通知对方。</p>
        )}
      </div>
      {!isIdea && (
        <div>
          <span className="label">时间{deviceTz !== tz ? `（按 ${tz} 时间）` : ''}</span>
          <div className="flex gap-2">
            <input
              className="input flex-[3]"
              type="date"
              aria-label="日期"
              value={date}
              onChange={e => setDate(e.target.value)}
            />
            <input
              className="input flex-[2]"
              type="time"
              aria-label="时刻（可不填）"
              value={time}
              onChange={e => setTime(e.target.value)}
            />
          </div>
          <div className="mt-1 flex items-center justify-between">
            <p className="text-[13px] text-muted">只填日期 = 那天之内</p>
            {(date || time) && (
              <button
                type="button"
                className="btn btn-sm btn-ghost -mr-2"
                onClick={() => {
                  setDate('')
                  setTime('')
                }}
              >
                清除时间
              </button>
            )}
          </div>
        </div>
      )}
      <div>
        <label className="label" htmlFor="edit-details">
          说明
        </label>
        <textarea
          id="edit-details"
          className="input min-h-[88px]"
          value={details}
          maxLength={2000}
          onChange={e => setDetails(e.target.value)}
        />
      </div>
      <div className="flex gap-2">
        <button type="button" className="btn btn-outline flex-1" onClick={onCancel} disabled={busy}>
          取消
        </button>
        <button type="submit" className="btn btn-primary flex-1" disabled={busy}>
          {busy ? '保存中…' : '保存'}
        </button>
      </div>
    </form>
  )
}

function NoteForm({ busy, onCancel, onSave }: { busy: boolean; onCancel: () => void; onSave: (text: string) => void }) {
  const [text, setText] = useState('')
  return (
    <form
      className="card flex flex-col gap-3 p-4"
      onSubmit={e => {
        e.preventDefault()
        const t = text.trim()
        if (t) onSave(t)
      }}
    >
      <textarea
        className="input min-h-[88px]"
        autoFocus
        aria-label="备注"
        placeholder="比如：已经约了周六上午"
        value={text}
        maxLength={2000}
        onChange={e => setText(e.target.value)}
      />
      <div className="flex gap-2">
        <button type="button" className="btn btn-outline flex-1" onClick={onCancel} disabled={busy}>
          取消
        </button>
        <button type="submit" className="btn btn-primary flex-1" disabled={busy || !text.trim()}>
          {busy ? '保存中…' : '添加备注'}
        </button>
      </div>
    </form>
  )
}
