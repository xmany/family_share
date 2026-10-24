// 看板: sections for the signed-in member (SPEC §6). Live via SSE; nothing here fetches on its own.

import { useMemo, useState } from 'react'
import type { Item } from '../../shared/types'
import { buildSections } from '../lib/board'
import { Link } from '../lib/router'
import { useApp, useNow } from '../lib/store'
import { ItemCard, RespondButtons } from '../components/items'
import { IconCalendar, IconChevron, IconPlus } from '../components/Icons'
import { NewItemForm } from '../components/NewItemForm'
import { Empty, PageHeader, Section } from '../components/ui'

export function BoardPage() {
  const { board } = useApp()
  const nowD = useNow()
  const members = useMemo(() => new Map((board?.members ?? []).map(m => [m.id, m])), [board?.members])
  const tz = board?.family.timezone ?? 'UTC'
  const meId = board?.me.id ?? ''
  const s = useMemo(() => buildSections(board?.items ?? [], meId, nowD, tz), [board?.items, meId, nowD, tz])
  const [adding, setAdding] = useState(false)

  if (!board) return null

  const cards = (items: Item[], withRespond = false) => (
    <div className="flex flex-col gap-2.5">
      {items.map(it => (
        <ItemCard
          key={it.id}
          item={it}
          members={members}
          meId={meId}
          now={nowD}
          tz={tz}
          footer={withRespond ? <RespondButtons item={it} /> : undefined}
        />
      ))}
    </div>
  )

  const nothingActive =
    s.awaitingMe.length + s.today.length + s.mine.length + s.waitingOnOthers.length + s.inProgress.length + s.ideas.length === 0

  return (
    <div className="page">
      <PageHeader
        title="看板"
        right={
          <div className="flex items-center gap-1">
            <Link to="/weekly" className="btn btn-sm btn-ghost">
              <IconCalendar size={17} />
              本周
            </Link>
            {!adding && (
              <button type="button" className="btn btn-sm btn-ghost" onClick={() => setAdding(true)}>
                <IconPlus size={17} />
                新建
              </button>
            )}
          </div>
        }
      />
      <div className="page-pad -mt-2">
        {adding && (
          <div className="mb-4">
            <NewItemForm me={board.me} members={board.members} tz={tz} onDone={() => setAdding(false)} />
          </div>
        )}
        {s.awaitingMe.length > 0 && (
          <Section title="等我回复" count={s.awaitingMe.length} hint="家人请你帮忙">
            {cards(s.awaitingMe, true)}
          </Section>
        )}

        <Section title="今天 / 已过期" count={s.today.length}>
          {s.today.length ? cards(s.today) : <Empty>今天没有要做的事</Empty>}
        </Section>

        <Section title="我的待办" count={s.mine.length}>
          {s.mine.length ? cards(s.mine) : <Empty>没有其他待办</Empty>}
        </Section>

        {s.waitingOnOthers.length > 0 && (
          <Section title="我在等别人" count={s.waitingOnOthers.length} hint="请家人做的事">
            {cards(s.waitingOnOthers)}
          </Section>
        )}

        {s.inProgress.length > 0 && (
          <Section title="进行中" count={s.inProgress.length} hint="已开始的和家人手上的事">
            {cards(s.inProgress)}
          </Section>
        )}

        {s.ideas.length > 0 && (
          <Section title="想法" count={s.ideas.length} hint="有空再说">
            {cards(s.ideas)}
          </Section>
        )}

        {s.doneThisWeek.length > 0 && (
          <Section title="本周完成" count={s.doneThisWeek.length}>
            {cards(s.doneThisWeek)}
          </Section>
        )}

        {nothingActive && !adding && (
          <div className="card mt-6 flex flex-col items-start gap-3 p-4">
            <p className="text-[15px] text-muted">看板是空的。在「对话」里说一句，比如「周六带孩子去游泳」，就会出现在这里；也可以点右上角「新建」自己加。</p>
            <Link to="/" className="btn btn-sm btn-primary">
              去对话
              <IconChevron size={16} />
            </Link>
          </div>
        )}
      </div>
    </div>
  )
}
