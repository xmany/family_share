import { describe, expect, it } from 'vitest'
import { createTestContext } from '../testing'
import { DAY, HOUR, zonedToUtc } from '../time'
import { DomainError } from './types'

const TZ = 'Australia/Sydney'
const iso = (date: string, time: string) => zonedToUtc(date, time, TZ).toISOString()
function code(fn: () => unknown): string {
  try {
    fn()
  } catch (e) {
    if (e instanceof DomainError) return e.code
    throw e
  }
  return 'ok'
}

describe('getBoard', () => {
  it('me, family, members, active + recently closed items (newest activity first), utterances oldest first', () => {
    const t = createTestContext()
    const a = t.as(t.husband)
    const old = t.domain.createItem(a, { kind: 'task', title: '旧的完成了' })
    t.domain.completeItem(a, old.id)
    t.clock.advance(8 * DAY)
    const recent = t.domain.createItem(a, { kind: 'task', title: '最近完成' })
    t.domain.completeItem(a, recent.id)
    t.clock.advance(HOUR)
    const active1 = t.domain.createItem(a, { kind: 'task', title: '买地毯' })
    t.clock.advance(HOUR)
    const active2 = t.domain.createItem(a, { kind: 'idea', title: '去日本玩' })
    t.clock.advance(HOUR)
    t.domain.addNote(t.as(t.wife), active1.id, '要灰色的')
    for (let i = 0; i < 35; i++) {
      t.domain.createUtterance(i % 2 ? t.wife.id : t.husband.id, 'text', `第${i}句`)
      t.clock.advance(1000)
    }
    const board = t.domain.getBoard(t.wife.id)
    expect(board.me.id).toBe(t.wife.id)
    expect(board.family).toEqual({ name: '测试家', timezone: 'Australia/Sydney' })
    expect(board.members.map(m => m.name)).toEqual(['老公', '老婆'])
    expect(board.items.map(i => i.title)).toEqual(['买地毯', '去日本玩', '最近完成'])
    expect(board.items.map(i => i.id)).not.toContain(old.id)
    expect(board.utterances).toHaveLength(30)
    expect(board.utterances[0]!.text).toBe('第5句')
    expect(board.utterances.at(-1)!.text).toBe('第34句')
    expect(board.serverTime).toBe(t.clock.now().toISOString())
    expect(active2.ownerId).toBeNull()
    expect(code(() => t.domain.getBoard('m_nobody'))).toBe('not_found')
  })
})

describe('getItemDetail', () => {
  it('item, notes, events oldest first, notifications', () => {
    const t = createTestContext()
    const item = t.domain.createItem(t.as(t.husband), { kind: 'task', title: '卖旧柜子', dueDate: '2026-10-25' })
    t.domain.addNote(t.as(t.husband), item.id, '挂闲鱼了')
    t.domain.updateItem(t.as(t.husband), item.id, { status: 'in_progress' })
    const d = t.domain.getItemDetail(item.id)!
    expect(d.item.id).toBe(item.id)
    expect(d.notes.map(n => n.text)).toEqual(['挂闲鱼了'])
    expect(d.events.map(e => e.type)).toEqual(['item_created', 'note_added', 'status_changed'])
    expect(d.notifications.map(n => n.dedupeKey)).toEqual([`due:${item.id}:2026-10-25`])
    expect(d.item.remindAt).toBe(iso('2026-10-25', '09:00'))
  })
})

describe('searchItems', () => {
  it('case-insensitive substring over title, details and notes; closed excluded by default', () => {
    const t = createTestContext()
    const a = t.as(t.husband)
    const rug = t.domain.createItem(a, { kind: 'task', title: '买地毯', details: '去IKEA看看' })
    const cab = t.domain.createItem(a, { kind: 'task', title: '卖旧柜子' })
    t.domain.addNote(a, cab.id, '挂到 Facebook Marketplace')
    const done = t.domain.createItem(a, { kind: 'task', title: '买地毯垫' })
    t.domain.completeItem(a, done.id)
    expect(t.domain.searchItems({ text: '地毯' }).map(i => i.id)).toEqual([rug.id])
    expect(t.domain.searchItems({ text: 'ikea' }).map(i => i.id)).toEqual([rug.id])
    expect(t.domain.searchItems({ text: 'facebook' }).map(i => i.id)).toEqual([cab.id])
    expect(t.domain.searchItems({ text: '地毯', includeClosed: true }).map(i => i.id).sort()).toEqual([rug.id, done.id].sort())
    expect(t.domain.searchItems({ status: ['done'] }).map(i => i.id)).toEqual([done.id])
    expect(t.domain.searchItems({ kind: 'idea' })).toEqual([])
    expect(t.domain.searchItems({ ownerId: t.wife.id })).toEqual([])
    expect(t.domain.searchItems({})).toHaveLength(2)
    expect(t.domain.searchItems({ limit: 1 })).toHaveLength(1)
    expect(t.domain.searchItems({ text: '100%' })).toEqual([])
  })

  it('limit defaults to 20', () => {
    const t = createTestContext()
    for (let i = 0; i < 25; i++) t.domain.createItem(t.as(t.husband), { kind: 'task', title: `事项${i}` })
    expect(t.domain.searchItems({ text: '事项' })).toHaveLength(20)
  })
})

describe('lists', () => {
  it('listActiveItems / listClosedSince / recentEvents / listNotes', () => {
    const t = createTestContext()
    const a = t.as(t.husband)
    const x = t.domain.createItem(a, { kind: 'task', title: 'x' })
    const y = t.domain.createItem(a, { kind: 'task', title: 'y' })
    t.clock.advance(HOUR)
    t.domain.updateItem(a, y.id, { status: 'dropped' })
    expect(t.domain.listActiveItems().map(i => i.id)).toEqual([x.id])
    expect(t.domain.listClosedSince(new Date(t.clock.now().getTime() - 1000)).map(i => i.id)).toEqual([y.id])
    expect(t.domain.listClosedSince(new Date(t.clock.now().getTime() + 1000))).toEqual([])
    expect(t.domain.recentEvents(2).map(e => e.type)).toEqual(['status_changed', 'item_created'])
    expect(t.domain.listNotes(x.id)).toEqual([])
  })
})

describe('utterances', () => {
  it('create / finish / get / recent, with changes from events', () => {
    const t = createTestContext()
    const u = t.domain.createUtterance(t.husband.id, 'voice', '  买地毯，周六之前  ', { audioPath: '/data/audio/x.webm' })
    expect(u).toMatchObject({ memberId: t.husband.id, source: 'voice', text: '买地毯，周六之前', status: 'processing', reply: null, changes: [] })
    const item = t.domain.createItem(t.asAi(t.husband, u.id), { kind: 'task', title: '买地毯', dueDate: '2026-10-24' })
    const fin = t.domain.finishUtterance(u.id, { status: 'done', reply: '记下了：买地毯，周六之前。', model: 'claude-opus-5-5', usage: { input: 10 } })
    expect(fin.status).toBe('done')
    expect(fin.reply).toBe('记下了：买地毯，周六之前。')
    expect(fin.changes).toEqual([
      { eventId: expect.any(Number), type: 'item_created', itemId: item.id, itemTitle: '买地毯', summary: '新建待办：买地毯（周六 10/24）' },
    ])
    const row = t.db.prepare('SELECT model, usage, audio_path FROM utterances WHERE id = ?').get(u.id) as Record<string, string>
    expect(row).toEqual({ model: 'claude-opus-5-5', usage: '{"input":10}', audio_path: '/data/audio/x.webm' })

    const q = t.domain.createUtterance(t.wife.id, 'text', '那个柜子呢')
    const clar = t.domain.finishUtterance(q.id, {
      status: 'clarify',
      reply: '你说的是哪个？',
      clarification: { question: '你说的是哪个？', options: ['卖旧柜子', '买新柜子'] },
    })
    expect(clar.clarification).toEqual({ question: '你说的是哪个？', options: ['卖旧柜子', '买新柜子'] })
    const reply = t.domain.createUtterance(t.wife.id, 'clarification', '卖旧柜子', { replyTo: q.id })
    expect(reply.source).toBe('clarification')
    expect(t.domain.recentUtterances(2).map(x => x.id)).toEqual([q.id, reply.id])
    expect(t.domain.getUtterance('u_missing')).toBeNull()
    expect(code(() => t.domain.finishUtterance('u_missing', { status: 'done', reply: null }))).toBe('not_found')
    expect(code(() => t.domain.createUtterance('m_nobody', 'text', 'x'))).toBe('invalid')
    expect(code(() => t.domain.createUtterance(t.wife.id, 'text', 'x', { replyTo: 'u_missing' }))).toBe('invalid')
    expect(code(() => t.domain.createItem({ type: 'ai', memberId: t.wife.id, utteranceId: 'u_missing' }, { kind: 'task', title: 'x' }))).toBe(
      'invalid',
    )
  })

  it('broadcasts the utterance on create and finish', () => {
    const t = createTestContext()
    const u = t.domain.createUtterance(t.wife.id, 'text', '你好')
    t.domain.finishUtterance(u.id, { status: 'error', reply: null, error: 'AI 没有配置' })
    expect(t.events.map(e => (e.type === 'utterance' ? e.utterance.status : e.type))).toEqual(['processing', 'error'])
  })
})

describe('members and family', () => {
  it('test context members', () => {
    const t = createTestContext()
    expect(t.husband).toMatchObject({ name: '老公', aliases: ['我老公', '他', '孩子爸', '爸爸'], role: 'adult', quietStart: '22:00', quietEnd: '07:30' })
    expect(t.wife).toMatchObject({ name: '老婆', aliases: ['我老婆', '她', '媳妇', '孩子妈', '妈妈'], role: 'adult', digestTime: '07:30' })
    expect(t.husband.color).not.toBe(t.wife.color)
    expect(t.domain.listMembers().map(m => m.id)).toEqual([t.husband.id, t.wife.id])
  })

  it('createMember / updateMember validate', () => {
    const t = createTestContext()
    const g = t.domain.createMember({ name: '外婆', aliases: ['姥姥', '姥姥', ' '], role: 'relative' })
    expect(g).toMatchObject({ name: '外婆', aliases: ['姥姥'], role: 'relative', language: 'zh-CN' })
    expect(code(() => t.domain.createMember({ name: '外婆', role: 'relative' }))).toBe('invalid')
    expect(code(() => t.domain.createMember({ name: '', role: 'adult' }))).toBe('invalid')
    expect(code(() => t.domain.createMember({ name: '舅舅', role: 'uncle' as never }))).toBe('invalid')
    const u = t.domain.updateMember(g.id, { quietStart: '21:30', quietEnd: '7:00', digestTime: null, aliases: ['姥姥', '奶奶'] })
    expect(u).toMatchObject({ quietStart: '21:30', quietEnd: '07:00', digestTime: null, aliases: ['姥姥', '奶奶'] })
    expect(code(() => t.domain.updateMember(g.id, { quietStart: '25:00' }))).toBe('invalid')
    expect(code(() => t.domain.updateMember(g.id, { name: '老公' }))).toBe('invalid')
    expect(code(() => t.domain.updateMember('m_nobody', { name: 'x' }))).toBe('not_found')
    expect(t.domain.getMember(g.id)!.quietStart).toBe('21:30')
    expect(t.domain.getMember('m_nobody')).toBeNull()
  })

  it('ensureFamily is idempotent; setTimezone re-plans local-time reminders', () => {
    const t = createTestContext()
    expect(t.domain.ensureFamily('别的名字', 'Asia/Shanghai')).toEqual({ name: '测试家', timezone: 'Australia/Sydney' })
    const item = t.domain.createItem(t.as(t.husband), { kind: 'task', title: '买菜', dueDate: '2026-10-23' })
    expect(t.outbox.scheduledForItem(item.id)[0]!.fireAt).toBe(iso('2026-10-23', '09:00'))
    expect(t.domain.setTimezone('Asia/Shanghai')).toEqual({ name: '测试家', timezone: 'Asia/Shanghai' })
    const sched = t.outbox.scheduledForItem(item.id)
    expect(sched).toHaveLength(1)
    expect(sched[0]!.fireAt).toBe(zonedToUtc('2026-10-23', '09:00', 'Asia/Shanghai').toISOString())
    expect(code(() => t.domain.setTimezone('Mars/Base'))).toBe('invalid')
  })

  it('getFamily before ensureFamily is not_found; custom test timezone works', () => {
    const t = createTestContext({ timezone: 'Asia/Shanghai', now: '2026-10-21T04:00:00.000Z' })
    expect(t.domain.getFamily().timezone).toBe('Asia/Shanghai')
    t.db.prepare('DELETE FROM family').run()
    expect(code(() => t.domain.getFamily())).toBe('not_found')
  })
})
