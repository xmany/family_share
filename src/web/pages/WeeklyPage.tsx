// 本周: what got done, what's stuck, ideas to decide on, the next 7 days' dated items (from board data).

import { useMemo } from 'react'
import type { Item } from '../../shared/types'
import { buildWeekly, daysSince } from '../lib/board'
import { useApp, useNow } from '../lib/store'
import { ItemCard } from '../components/items'
import { Empty, PageHeader, Section } from '../components/ui'

export function WeeklyPage() {
  const { board } = useApp()
  const nowD = useNow()
  const members = useMemo(() => new Map((board?.members ?? []).map(m => [m.id, m])), [board?.members])
  const tz = board?.family.timezone ?? 'UTC'
  const meId = board?.me.id ?? ''
  const w = useMemo(() => buildWeekly(board?.items ?? [], nowD, tz), [board?.items, nowD, tz])
  if (!board) return null

  const list = (items: Item[], note?: (it: Item) => string) => (
    <div className="flex flex-col gap-2.5">
      {items.map(it => (
        <div key={it.id}>
          <ItemCard item={it} members={members} meId={meId} now={nowD} tz={tz} />
          {note && <p className="mt-1 px-2 text-[12.5px] text-muted">{note(it)}</p>}
        </div>
      ))}
    </div>
  )

  return (
    <div className="page">
      <PageHeader title="本周" back="/board" />
      <div className="page-pad -mt-2">
        <p className="px-1 pt-1 text-[15px] text-muted">
          这一周完成了 <b className="text-ink">{w.done.length}</b> 件事
          {w.stuck.length > 0 && (
            <>
              ，有 <b className="text-ink">{w.stuck.length}</b> 件放了一周以上
            </>
          )}
          。
        </p>

        <Section title="接下来 7 天" count={w.upcoming.reduce((n, d) => n + d.items.length, 0)}>
          {w.upcoming.length === 0 ? (
            <Empty>接下来 7 天没有定了时间的事</Empty>
          ) : (
            <div className="flex flex-col gap-4">
              {w.upcoming.map(day => (
                <div key={day.date}>
                  <div className="mb-1.5 px-1 text-[14px] font-semibold text-muted">{day.label}</div>
                  {list(day.items)}
                </div>
              ))}
            </div>
          )}
        </Section>

        <Section title="卡住了" count={w.stuck.length} hint="开了一周以上还没做完">
          {w.stuck.length ? (
            list(w.stuck, it => `已经 ${daysSince(it.createdAt, nowD)} 天了 — 定个时间，拆小一点，或者不做了`)
          ) : (
            <Empty>没有卡住的事</Empty>
          )}
        </Section>

        <Section title="想法" count={w.ideas.length} hint="要不要定下来？">
          {w.ideas.length ? list(w.ideas) : <Empty>还没有想法</Empty>}
        </Section>

        <Section title="完成了" count={w.done.length}>
          {w.done.length ? list(w.done) : <Empty>这周还没有完成的事</Empty>}
        </Section>
      </div>
    </div>
  )
}
