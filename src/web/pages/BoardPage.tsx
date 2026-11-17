// 看板: sections for the signed-in member (SPEC §6). Live via SSE; nothing here fetches on its own.

import { useMemo, useState } from 'react'
import type { Item } from '../../shared/types'
import { buildSections } from '../lib/board'
import { Link } from '../lib/router'
import { useApp, useNow } from '../lib/store'
import { ItemList, ItemRow, RespondButtons } from '../components/items'
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

  const rows = (items: Item[], { respond = false, sky = false } = {}) => (
    <ItemList sky={sky}>
      {items.map(it => (
        <ItemRow
          key={it.id}
          item={it}
          members={members}
          meId={meId}
          now={nowD}
          tz={tz}
          footer={respond ? <RespondButtons item={it} /> : undefined}
        />
      ))}
    </ItemList>
  )

  const nothingActive =
    s.awaitingMe.length + s.today.length + s.mine.length + s.waitingOnOthers.length + s.inProgress.length + s.ideas.length === 0

  return (
    <div className="page">
      <PageHeader
        title="看板"
        right={
          <>
            <Link to="/weekly" className="btn btn-sm">
              <IconCalendar size={16} />
              本周
            </Link>
            {!adding && (
              <button type="button" className="btn btn-sm" onClick={() => setAdding(true)}>
                <IconPlus size={16} />
                新建
              </button>
            )}
          </>
        }
      />
      <div className="page-pad -mt-3">
        {adding && (
          <div className="mt-3 mb-2">
            <NewItemForm me={board.me} members={board.members} tz={tz} onDone={() => setAdding(false)} />
          </div>
        )}
        {s.awaitingMe.length > 0 && (
          <Section title="等我回复" count={s.awaitingMe.length} hint="家人请你帮忙">
            {rows(s.awaitingMe, { respond: true, sky: true })}
          </Section>
        )}

        <Section title="今天 / 已过期" count={s.today.length}>
          {s.today.length ? rows(s.today) : <Empty>今天没有要做的事</Empty>}
        </Section>

        <Section title="我的待办" count={s.mine.length}>
          {s.mine.length ? rows(s.mine) : <Empty>没有其他待办</Empty>}
        </Section>

        {s.waitingOnOthers.length > 0 && (
          <Section title="我在等别人" count={s.waitingOnOthers.length} hint="请家人做的事">
            {rows(s.waitingOnOthers)}
          </Section>
        )}

        {s.inProgress.length > 0 && (
          <Section title="进行中" count={s.inProgress.length} hint="已开始的和家人手上的事">
            {rows(s.inProgress)}
          </Section>
        )}

        {s.ideas.length > 0 && (
          <Section title="想法" count={s.ideas.length} hint="有空再说">
            {rows(s.ideas)}
          </Section>
        )}

        {s.doneThisWeek.length > 0 && (
          <Section title="本周完成" count={s.doneThisWeek.length}>
            {rows(s.doneThisWeek)}
          </Section>
        )}

        {nothingActive && !adding && (
          <div className="card mt-6 flex flex-col items-start gap-3 p-5">
            <p className="text-[15px] text-ink-2">
              看板是空的。在「对话」里说一句，比如「周六带孩子去游泳」，就会出现在这里；也可以点右上角「新建」自己加。
            </p>
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
