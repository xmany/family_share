// The private chat with the assistant: a private utterance exists only for the member who said it.
// What it changes on the board is shared like everything else.

import { describe, expect, it } from 'vitest'
import { createTestContext } from '../testing'
import { DomainError } from './types'

function code(fn: () => unknown): string {
  try {
    fn()
  } catch (e) {
    if (e instanceof DomainError) return e.code
    throw e
  }
  return 'ok'
}

describe('utterance visibility', () => {
  it("defaults to the family chat, and keeps 'private' when asked", () => {
    const t = createTestContext()
    expect(t.domain.createUtterance(t.wife.id, 'text', '明天买菜').visibility).toBe('family')
    const secret = t.domain.createUtterance(t.wife.id, 'text', '给老公准备生日礼物', { visibility: 'private' })
    expect(secret.visibility).toBe('private')
    expect(t.domain.getUtterance(secret.id)!.visibility).toBe('private')
    expect(code(() => t.domain.createUtterance(t.wife.id, 'text', 'x', { visibility: 'everyone' as never }))).toBe('invalid')
  })

  it('recentUtterances: the family chat by default, a private chat only for its owner', () => {
    const t = createTestContext()
    const say = (who: string, text: string, visibility: 'family' | 'private') => {
      t.domain.createUtterance(who, 'text', text, { visibility })
      t.clock.advance(1000)
    }
    say(t.wife.id, '大家周六去公园', 'family')
    say(t.wife.id, '老婆的私事', 'private')
    say(t.husband.id, '老公的私事', 'private')
    say(t.husband.id, '好的', 'family')

    const texts = (list: { text: string }[]) => list.map(u => u.text)
    expect(texts(t.domain.recentUtterances(10))).toEqual(['大家周六去公园', '好的'])
    expect(texts(t.domain.recentUtterances(10, 'family'))).toEqual(['大家周六去公园', '好的'])
    expect(texts(t.domain.recentUtterances(10, { privateOf: t.wife.id }))).toEqual(['老婆的私事'])
    expect(texts(t.domain.recentUtterances(10, { privateOf: t.husband.id }))).toEqual(['老公的私事'])
    expect(texts(t.domain.recentUtterances(10, { visibleTo: t.wife.id }))).toEqual(['大家周六去公园', '老婆的私事', '好的'])
    expect(texts(t.domain.recentUtterances(10, { visibleTo: t.husband.id }))).toEqual(['大家周六去公园', '老公的私事', '好的'])
    expect(texts(t.domain.recentUtterances(10, { privateOf: 'm_nobody' }))).toEqual([])
  })

  it("getBoard shows my own private chat and never someone else's", () => {
    const t = createTestContext()
    t.domain.createUtterance(t.husband.id, 'text', '周六去公园')
    t.clock.advance(1000)
    t.domain.createUtterance(t.wife.id, 'text', '给老公准备生日礼物', { visibility: 'private' })
    const texts = (memberId: string) => t.domain.getBoard(memberId).utterances.map(u => u.text)
    expect(texts(t.wife.id)).toEqual(['周六去公园', '给老公准备生日礼物'])
    expect(texts(t.husband.id)).toEqual(['周六去公园'])
  })

  it('getBoard keeps 30 of each chat: a busy private chat does not push the family chat out', () => {
    const t = createTestContext()
    t.domain.createUtterance(t.husband.id, 'text', '周六去公园')
    for (let i = 0; i < 40; i++) {
      t.clock.advance(1000)
      t.domain.createUtterance(t.wife.id, 'text', `私事${i}`, { visibility: 'private' })
    }
    const mine = t.domain.getBoard(t.wife.id).utterances
    expect(mine.filter(u => u.visibility === 'family').map(u => u.text)).toEqual(['周六去公园'])
    expect(mine.filter(u => u.visibility === 'private')).toHaveLength(30)
    expect(mine.at(-1)!.text).toBe('私事39')
  })

  it('what a private utterance changes still lands on the shared board', () => {
    const t = createTestContext()
    const u = t.domain.createUtterance(t.wife.id, 'text', '让老公明天买牛奶', { visibility: 'private' })
    const item = t.domain.sendRequest(t.asAi(t.wife, u.id), { toMemberId: t.husband.id, title: '买牛奶' })
    t.domain.finishUtterance(u.id, { status: 'done', reply: '已请老公买牛奶' })
    const husbandBoard = t.domain.getBoard(t.husband.id)
    expect(husbandBoard.items.map(i => i.id)).toContain(item.id)
    expect(husbandBoard.utterances).toEqual([])
    expect(t.outbox.scheduledForItem(item.id).some(n => n.kind === 'request_new' && n.memberId === t.husband.id)).toBe(true)
  })

  it('an answer stays in the chat that asked', () => {
    const t = createTestContext()
    const familyQ = t.domain.createUtterance(t.wife.id, 'text', '买那个')
    const privateQ = t.domain.createUtterance(t.wife.id, 'text', '订那个', { visibility: 'private' })
    // same chat: fine (anyone may answer in the family chat; only the owner in a private one)
    expect(code(() => t.domain.createUtterance(t.husband.id, 'clarification', '牛奶', { replyTo: familyQ.id }))).toBe('ok')
    expect(code(() => t.domain.createUtterance(t.wife.id, 'clarification', '餐厅', { replyTo: privateQ.id, visibility: 'private' }))).toBe('ok')
    // across chats, or into someone else's private chat: the question "does not exist"
    expect(code(() => t.domain.createUtterance(t.wife.id, 'clarification', '餐厅', { replyTo: privateQ.id }))).toBe('invalid')
    expect(code(() => t.domain.createUtterance(t.wife.id, 'clarification', '牛奶', { replyTo: familyQ.id, visibility: 'private' }))).toBe('invalid')
    expect(code(() => t.domain.createUtterance(t.husband.id, 'clarification', '餐厅', { replyTo: privateQ.id }))).toBe('invalid')
    expect(code(() => t.domain.createUtterance(t.husband.id, 'clarification', '餐厅', { replyTo: privateQ.id, visibility: 'private' }))).toBe('invalid')
  })

  it("only its owner can undo a private utterance; to another adult it is an unknown id", () => {
    const t = createTestContext()
    const u = t.domain.createUtterance(t.wife.id, 'text', '记一下买礼物', { visibility: 'private' })
    const item = t.domain.createItem(t.asAi(t.wife, u.id), { kind: 'task', title: '买礼物' })
    t.domain.finishUtterance(u.id, { status: 'done', reply: '记下了' })

    let message = ''
    try {
      t.domain.undoUtterance(t.as(t.husband), u.id)
    } catch (e) {
      expect(e).toBeInstanceOf(DomainError)
      expect((e as DomainError).code).toBe('not_found')
      message = (e as DomainError).message
    }
    expect(message).not.toBe('')
    expect(message).not.toContain('礼物')
    expect(t.domain.getItem(item.id)).not.toBeNull()

    const undone = t.domain.undoUtterance(t.as(t.wife), u.id)
    expect(undone.utterance.status).toBe('undone')
    expect(t.domain.getItem(item.id)).toBeNull()
  })

  it('a family utterance can still be undone by another adult', () => {
    const t = createTestContext()
    const u = t.domain.createUtterance(t.wife.id, 'text', '记一下买菜')
    t.domain.createItem(t.asAi(t.wife, u.id), { kind: 'task', title: '买菜' })
    t.domain.finishUtterance(u.id, { status: 'done', reply: '记下了' })
    expect(t.domain.undoUtterance(t.as(t.husband), u.id).utterance.status).toBe('undone')
  })
})
