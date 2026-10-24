// 新建: add an item by hand — the fallback when the AI isn't configured or got it wrong.
// Requests go to the chosen person, who gets 接受 / 做不了 (same as asking through the chat).

import { useState } from 'react'
import type { CreateItemBody } from '../../shared/api'
import type { ItemKind, Member } from '../../shared/types'
import { zonedToUtc } from '../../shared/time'
import { api, errorMessage } from '../lib/api'
import { mergeItems } from '../lib/store'
import { toast } from '../lib/toast'

const KINDS: Array<{ kind: ItemKind; label: string; hint: string }> = [
  { kind: 'task', label: '我来做', hint: '记在自己名下' },
  { kind: 'request', label: '请家人做', hint: '对方要接受或说做不了' },
  { kind: 'idea', label: '想法', hint: '不急，有空再说' },
  { kind: 'reminder', label: '提醒', hint: '到时间提醒我' },
]

export function NewItemForm({
  me,
  members,
  tz,
  onDone,
}: {
  me: Member
  members: Member[]
  tz: string
  onDone: (itemId: string | null) => void
}) {
  const others = members.filter(m => m.id !== me.id)
  const [kind, setKind] = useState<ItemKind>('task')
  const [title, setTitle] = useState('')
  const [ownerId, setOwnerId] = useState(others[0]?.id ?? '')
  const [date, setDate] = useState('')
  const [time, setTime] = useState('')
  const [details, setDetails] = useState('')
  const [busy, setBusy] = useState(false)
  const deviceTz = Intl.DateTimeFormat().resolvedOptions().timeZone

  const submit = async () => {
    const t = title.trim()
    if (!t) return toast('写一下要做什么', 'danger')
    if (kind === 'request' && !ownerId) return toast('请选择请谁来做', 'danger')
    if (time && !date) return toast('请先选日期', 'danger')
    if (kind === 'reminder' && !(date && time)) return toast('提醒需要日期和时间', 'danger')
    const body: CreateItemBody = { kind, title: t }
    if (details.trim()) body.details = details.trim()
    if (kind === 'request') body.ownerId = ownerId
    if (kind !== 'idea' && date) {
      if (time) {
        try {
          body.dueAt = zonedToUtc(date, time.slice(0, 5), tz).toISOString()
        } catch {
          return toast('时间格式不对', 'danger')
        }
      } else body.dueDate = date
    }
    setBusy(true)
    try {
      const res = await api.createItem(body)
      mergeItems([res.item])
      toast(kind === 'request' ? `已请${others.find(m => m.id === ownerId)?.name ?? '对方'}帮忙` : '已添加', 'ok')
      onDone(res.item.id)
    } catch (e) {
      toast(errorMessage(e), 'danger')
    } finally {
      setBusy(false)
    }
  }

  return (
    <form
      className="card flex flex-col gap-3.5 p-4"
      onSubmit={e => {
        e.preventDefault()
        void submit()
      }}
    >
      <div role="radiogroup" aria-label="类型" className="grid grid-cols-2 gap-2">
        {KINDS.filter(k => k.kind !== 'request' || others.length > 0).map(k => (
          <button
            key={k.kind}
            type="button"
            role="radio"
            aria-checked={kind === k.kind}
            aria-label={`${k.label}：${k.hint}`}
            className={`btn btn-sm flex-col !items-start !py-2 text-left ${kind === k.kind ? 'btn-primary' : 'btn-outline'}`}
            onClick={() => setKind(k.kind)}
          >
            <span className="text-[15px]">{k.label}</span>
            <span className="text-[12px] opacity-75">{k.hint}</span>
          </button>
        ))}
      </div>
      <div>
        <label className="label" htmlFor="new-title">
          {kind === 'request' ? '请对方做什么' : kind === 'idea' ? '想法' : '要做什么'}
        </label>
        <input
          id="new-title"
          className="input"
          value={title}
          maxLength={200}
          autoFocus
          placeholder={kind === 'request' ? '周六上午带孩子出去' : kind === 'idea' ? '客厅换块地毯' : '把旧柜子挂到 Marketplace'}
          onChange={e => setTitle(e.target.value)}
        />
      </div>
      {kind === 'request' && (
        <div>
          <label className="label" htmlFor="new-owner">
            请谁来做
          </label>
          <select id="new-owner" className="input" value={ownerId} onChange={e => setOwnerId(e.target.value)}>
            {others.map(m => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
          </select>
        </div>
      )}
      {kind !== 'idea' && (
        <div>
          <span className="label">
            {kind === 'reminder' ? '什么时候提醒' : '时间（可不填）'}
            {deviceTz !== tz ? `（按 ${tz} 时间）` : ''}
          </span>
          <div className="flex gap-2">
            <input className="input flex-[3]" type="date" aria-label="日期" value={date} onChange={e => setDate(e.target.value)} />
            <input
              className="input flex-[2]"
              type="time"
              aria-label="时刻（可不填）"
              value={time}
              onChange={e => setTime(e.target.value)}
            />
          </div>
        </div>
      )}
      <div>
        <label className="label" htmlFor="new-details">
          说明（可不填）
        </label>
        <textarea
          id="new-details"
          className="input min-h-[72px]"
          value={details}
          maxLength={2000}
          onChange={e => setDetails(e.target.value)}
        />
      </div>
      <div className="flex gap-2">
        <button type="button" className="btn btn-outline flex-1" onClick={() => onDone(null)} disabled={busy}>
          取消
        </button>
        <button type="submit" className="btn btn-primary flex-1" disabled={busy}>
          {busy ? '保存中…' : kind === 'request' ? '发出请求' : '添加'}
        </button>
      </div>
    </form>
  )
}
