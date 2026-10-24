import { describe, expect, it } from 'vitest'
import type { Item } from '../../shared/types'
import { zonedToUtc } from '../time'
import {
  STATUS_LABEL_ZH,
  clip,
  dueLabel,
  nameLookup,
  summarizeCreated,
  summarizeFieldsUpdated,
  summarizeNote,
  summarizeRequestSent,
  summarizeResponded,
  summarizeSnoozed,
  summarizeStatus,
} from './describe'

const TZ = 'Australia/Sydney'
const NOW = zonedToUtc('2026-10-21', '12:00', TZ)
const nameOf = nameLookup([
  { id: 'm_h', name: '老公' },
  { id: 'm_w', name: '老婆' },
] as never)
const env = { now: NOW, tz: TZ, nameOf }
const base = { id: 'i_1', title: '买地毯', ownerId: 'm_h', dueAt: null, dueDate: null, kind: 'task' } as unknown as Item

describe('labels', () => {
  it('status labels', () => {
    expect(STATUS_LABEL_ZH).toEqual({
      open: '待办',
      pending: '待回复',
      accepted: '已接受',
      declined: '做不了',
      in_progress: '进行中',
      blocked: '卡住了',
      done: '完成',
      dropped: '不做了',
    })
  })
  it('due labels are relative to the reference instant', () => {
    expect(dueLabel({ dueAt: zonedToUtc('2026-10-21', '15:00', TZ).toISOString(), dueDate: null }, NOW, TZ)).toBe('今天 15:00')
    expect(dueLabel({ dueAt: null, dueDate: '2026-10-22' }, NOW, TZ)).toBe('明天')
    expect(dueLabel({ dueAt: null, dueDate: null }, NOW, TZ)).toBeNull()
  })
  it('clip counts characters and adds an ellipsis', () => {
    expect(clip('一二三四五', 5)).toBe('一二三四五')
    expect(clip('一二三四五六', 5)).toBe('一二三四…')
    expect(clip('  a \n b  ', 10)).toBe('a b')
  })
  it('never shows ids for unknown members', () => {
    expect(nameOf('m_zzz')).toBe('家人')
    expect(nameOf(null)).toBe('系统')
  })
})

describe('event summaries', () => {
  it('created', () => {
    expect(summarizeCreated(base, 'm_h', env)).toBe('新建待办：买地毯')
    expect(summarizeCreated({ ...base, ownerId: 'm_w', dueDate: '2026-10-22' }, 'm_h', env)).toBe('新建待办 → 老婆：买地毯（明天）')
    expect(summarizeCreated({ ...base, kind: 'idea', ownerId: null, title: '去日本玩' }, 'm_h', env)).toBe('新建想法：去日本玩')
  })
  it('request sent / responded', () => {
    const req = { ...base, kind: 'request', ownerId: 'm_w', title: '带孩子出去', dueAt: zonedToUtc('2026-10-24', '08:30', TZ).toISOString() } as Item
    expect(summarizeRequestSent(req, 1, env)).toBe('请求 → 老婆：带孩子出去（周六 10/24 08:30）')
    expect(summarizeRequestSent(req, 2, env)).toBe('再次请求 → 老婆：带孩子出去（周六 10/24 08:30）')
    expect(summarizeResponded(req, 'accept', null, env)).toBe('老婆接受了：带孩子出去')
    expect(summarizeResponded(req, 'decline', '周六有事', env)).toBe('老婆做不了：带孩子出去（周六有事）')
  })
  it('status, snooze, note, fields', () => {
    expect(summarizeStatus('卖旧柜子', 'open', 'in_progress')).toBe('卖旧柜子：待办 → 进行中')
    expect(summarizeStatus('卖旧柜子', 'open', 'done')).toBe('完成：卖旧柜子')
    expect(summarizeStatus('卖旧柜子', 'blocked', 'dropped')).toBe('不做了：卖旧柜子')
    expect(summarizeSnoozed('卖旧柜子', zonedToUtc('2026-10-22', '09:00', TZ), env)).toBe('推迟：卖旧柜子 → 明天 09:00')
    expect(summarizeNote('卖旧柜子', '挂出去了，80块')).toBe('备注（卖旧柜子）：挂出去了，80块')
    expect(
      summarizeFieldsUpdated('卖旧柜子', { due: { dueAt: zonedToUtc('2026-10-25', '10:00', TZ).toISOString(), dueDate: null }, priority: 'high' }, env),
    ).toBe('卖旧柜子：时间 → 周日 10/25 10:00，优先级 → 高')
    expect(summarizeFieldsUpdated('新名字', { title: { from: '旧名字', to: '新名字' } }, env)).toBe('新名字：改名（原：旧名字）')
    expect(summarizeFieldsUpdated('x', { due: { dueAt: null, dueDate: null } }, env)).toBe('x：去掉时间')
  })
})
