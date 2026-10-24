import { describe, expect, it } from 'vitest'
import type { Item } from '../../shared/types'
import { buildSections, buildWeekly, dueInfo, pendingForMeCount } from './board'

const TZ = 'Australia/Sydney'
// 2026-10-21 14:00 in Sydney (AEDT, UTC+11), a Wednesday
const NOW = new Date('2026-10-21T03:00:00.000Z')
const ME = 'm_me'
const SPOUSE = 'm_spouse'

let seq = 0
function mk(p: Partial<Item>): Item {
  seq++
  return {
    id: p.id ?? `i_${seq}`,
    kind: 'task',
    title: `item ${seq}`,
    details: null,
    status: 'open',
    ownerId: ME,
    createdBy: ME,
    requestedBy: null,
    dueAt: null,
    dueDate: null,
    remindAt: null,
    snoozedUntil: null,
    snoozeCount: 0,
    priority: 'normal',
    parentId: null,
    tags: [],
    createdAt: '2026-10-20T00:00:00.000Z',
    updatedAt: '2026-10-20T00:00:00.000Z',
    completedAt: null,
    respondedAt: null,
    lastActivityAt: '2026-10-20T00:00:00.000Z',
    ...p,
  }
}

describe('dueInfo', () => {
  it('labels instants and dates relative to the family timezone', () => {
    const tonight = dueInfo(mk({ dueAt: '2026-10-21T09:30:00.000Z' }), NOW, TZ)! // 20:30 local
    expect(tonight.label).toBe('今天 20:30')
    expect(tonight.today).toBe(true)
    expect(tonight.overdue).toBe(false)

    const lateLastNight = dueInfo(mk({ dueAt: '2026-10-20T12:00:00.000Z' }), NOW, TZ)! // 23:00 yesterday
    expect(lateLastNight.label).toBe('昨天 23:00')
    expect(lateLastNight.overdue).toBe(true)

    // 2026-10-21T14:00Z is already Thursday 01:00 in Sydney
    expect(dueInfo(mk({ dueAt: '2026-10-21T14:00:00.000Z' }), NOW, TZ)!.label).toBe('明天 01:00')

    const sat = dueInfo(mk({ dueDate: '2026-10-24' }), NOW, TZ)!
    expect(sat.label).toBe('周六 10/24')
    expect(sat.overdue).toBe(false)
    expect(dueInfo(mk({ dueDate: '2026-10-21' }), NOW, TZ)!.today).toBe(true)
    expect(dueInfo(mk({ dueDate: '2026-10-19' }), NOW, TZ)!.overdue).toBe(true)
    expect(dueInfo(mk({}), NOW, TZ)).toBeNull()
  })
})

describe('buildSections', () => {
  const items = {
    askedMe: mk({ kind: 'request', status: 'pending', ownerId: ME, requestedBy: SPOUSE, createdBy: SPOUSE }),
    dueToday: mk({ dueAt: '2026-10-21T08:00:00.000Z' }),
    overdueDate: mk({ dueDate: '2026-10-20' }),
    acceptedDueToday: mk({ kind: 'request', status: 'accepted', requestedBy: SPOUSE, createdBy: SPOUSE, dueDate: '2026-10-21' }),
    tomorrow: mk({ dueDate: '2026-10-22' }),
    snoozedOverdue: mk({ dueDate: '2026-10-19', snoozedUntil: '2026-10-21T22:00:00.000Z' }),
    undated: mk({ lastActivityAt: '2026-10-21T01:00:00.000Z' }),
    myInProgress: mk({ status: 'in_progress' }),
    iAsked: mk({ kind: 'request', status: 'accepted', ownerId: SPOUSE, requestedBy: ME }),
    iAskedPending: mk({ kind: 'request', status: 'pending', ownerId: SPOUSE, requestedBy: ME }),
    iAskedDeclined: mk({ kind: 'request', status: 'declined', ownerId: SPOUSE, requestedBy: ME }),
    iHandedOver: mk({ ownerId: SPOUSE, createdBy: ME }),
    spouseOwn: mk({ ownerId: SPOUSE, createdBy: SPOUSE }),
    iDeclined: mk({ kind: 'request', status: 'declined', ownerId: ME, requestedBy: SPOUSE, createdBy: SPOUSE }),
    idea: mk({ kind: 'idea', ownerId: null }),
    myIdea: mk({ kind: 'idea', ownerId: ME }),
    doneRecently: mk({ status: 'done', completedAt: '2026-10-19T03:00:00.000Z' }),
    doneLongAgo: mk({ status: 'done', completedAt: '2026-10-10T03:00:00.000Z' }),
    dropped: mk({ status: 'dropped', completedAt: '2026-10-20T03:00:00.000Z' }),
  }
  const s = buildSections(Object.values(items), ME, NOW, TZ)
  const ids = (list: Item[]) => list.map(i => i.id)

  it('puts pending requests to me under 等我回复', () => {
    expect(ids(s.awaitingMe)).toEqual([items.askedMe.id])
  })

  it('puts my overdue and due-today items under 今天 / 已过期, overdue first', () => {
    expect(ids(s.today)).toEqual([items.overdueDate.id, items.dueToday.id, items.acceptedDueToday.id])
  })

  it('keeps the rest of my open items (incl. snoozed) under 我的待办, dated first', () => {
    expect(ids(s.mine)).toEqual([items.snoozedOverdue.id, items.tomorrow.id, items.undated.id, items.iAskedDeclined.id])
  })

  it('lists requests I sent that are still open and items I handed over under 我在等别人', () => {
    expect(new Set(ids(s.waitingOnOthers))).toEqual(new Set([items.iAsked.id, items.iAskedPending.id, items.iHandedOver.id]))
  })

  it('moves a request of mine that came back declined to 我的待办 (I decide what next)', () => {
    expect(ids(s.waitingOnOthers)).not.toContain(items.iAskedDeclined.id)
    expect(ids(s.mine)).toContain(items.iAskedDeclined.id)
  })

  it('shows started items and other family members’ items under 进行中', () => {
    expect(new Set(ids(s.inProgress))).toEqual(new Set([items.myInProgress.id, items.spouseOwn.id]))
  })

  it('collects ideas and this week’s completions; hides dropped, old and declined-by-me items', () => {
    expect(new Set(ids(s.ideas))).toEqual(new Set([items.idea.id, items.myIdea.id]))
    expect(ids(s.doneThisWeek)).toEqual([items.doneRecently.id])
    const all = new Set(Object.values(s).flatMap((l: Item[]) => ids(l)))
    expect(all.has(items.dropped.id)).toBe(false)
    expect(all.has(items.doneLongAgo.id)).toBe(false)
    expect(all.has(items.iDeclined.id)).toBe(false)
  })

  it('places every item at most once', () => {
    const flat = Object.values(s).flatMap((l: Item[]) => ids(l))
    expect(new Set(flat).size).toBe(flat.length)
  })

  it('counts requests waiting for my answer (tab badge)', () => {
    expect(pendingForMeCount(Object.values(items), ME)).toBe(1)
    expect(pendingForMeCount(Object.values(items), SPOUSE)).toBe(1) // the one I sent
  })
})

describe('buildWeekly', () => {
  it('groups done, stuck, ideas and the next 7 days', () => {
    const old = mk({ createdAt: '2026-10-01T00:00:00.000Z' })
    const oldIdea = mk({ kind: 'idea', ownerId: null, createdAt: '2026-09-01T00:00:00.000Z' })
    const thu = mk({ dueAt: '2026-10-22T00:00:00.000Z' }) // Thu 11:00 local
    const thuEarly = mk({ dueDate: '2026-10-22', ownerId: SPOUSE })
    const tue = mk({ dueDate: '2026-10-27' }) // today + 6
    const wedNext = mk({ dueDate: '2026-10-28' }) // today + 7: outside
    const done = mk({ status: 'done', completedAt: '2026-10-20T00:00:00.000Z' })
    const w = buildWeekly([old, oldIdea, thu, thuEarly, tue, wedNext, done], NOW, TZ)
    expect(w.done.map(i => i.id)).toEqual([done.id])
    expect(w.stuck.map(i => i.id)).toEqual([old.id])
    expect(w.ideas.map(i => i.id)).toEqual([oldIdea.id])
    expect(w.upcoming.map(d => [d.date, d.label, d.items.map(i => i.id)])).toEqual([
      ['2026-10-22', '明天', [thu.id, thuEarly.id]],
      ['2026-10-27', '周二 10/27', [tue.id]],
    ])
  })
})
