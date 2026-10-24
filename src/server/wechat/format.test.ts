import { describe, expect, it } from 'vitest'
import { createTestContext } from '../testing'
import { verifyLinkToken } from '../tokens'
import { HOUR } from '../time'
import {
  linkActionsForItem,
  linkActionsForKind,
  notificationLinkUrl,
  notificationTemplateData,
  replyTemplateData,
  sanitizeWechatValue,
} from './format'

describe('sanitizeWechatValue', () => {
  it('replaces line breaks and tabs with a space and collapses whitespace', () => {
    expect(sanitizeWechatValue('买牛奶\r\n还有\n面包\t两袋')).toBe('买牛奶 还有 面包 两袋')
    expect(sanitizeWechatValue('  a   b  ')).toBe('a b')
    expect(sanitizeWechatValue('一\u2028二\u2029三')).toBe('一 二 三')
  })

  it('strips control and format characters', () => {
    expect(sanitizeWechatValue('a\u0000b\u0007c\u001bd\u007f')).toBe('abcd')
    expect(sanitizeWechatValue('零\u200b宽\u200d字\ufeff符\u202e')).toBe('零宽字符')
  })

  it('strips emoji, including flags, skin tones, ZWJ sequences and keycaps', () => {
    expect(sanitizeWechatValue('✅ 可以')).toBe('可以')
    expect(sanitizeWechatValue('🙅 不行')).toBe('不行')
    expect(sanitizeWechatValue('去🇯🇵玩')).toBe('去玩')
    expect(sanitizeWechatValue('👍🏽好')).toBe('好')
    expect(sanitizeWechatValue('\u{1F468}\u200d\u{1F469}\u200d\u{1F467}家')).toBe('家')
    expect(sanitizeWechatValue('\u2764\ufe0f爱')).toBe('爱')
    expect(sanitizeWechatValue('1\ufe0f\u20e3号')).toBe('1号')
    // ordinary punctuation, digits and CJK stay
    expect(sanitizeWechatValue('周六 08:30 · 80块（可议）')).toBe('周六 08:30 · 80块（可议）')
  })

  it('truncates to 20 characters (code points) with …', () => {
    const twenty = '一二三四五六七八九十一二三四五六七八九十'
    expect(sanitizeWechatValue(twenty)).toBe(twenty)
    expect(sanitizeWechatValue(twenty + '多')).toBe('一二三四五六七八九十一二三四五六七八九…')
    expect(Array.from(sanitizeWechatValue('𠀀'.repeat(30))).length).toBe(20) // astral CJK counts as one
    expect(sanitizeWechatValue('abc', 2)).toBe('a…')
  })

  it('returns an empty string for nothing left', () => {
    expect(sanitizeWechatValue(null)).toBe('')
    expect(sanitizeWechatValue('🎉🎉\n')).toBe('')
  })
})

describe('links', () => {
  it('allowed actions per kind (SPEC §7)', () => {
    expect(linkActionsForKind('request_new')).toEqual(['accept', 'decline', 'view'])
    expect(linkActionsForKind('request_followup')).toEqual(['accept', 'decline', 'view'])
    for (const k of ['due', 'explicit', 'assigned', 'stale'] as const) expect(linkActionsForKind(k)).toEqual(['done', 'view'])
    for (const k of ['request_noreply', 'request_answered', 'digest', 'weekly', 'test'] as const) expect(linkActionsForKind(k)).toEqual(['view'])
  })

  it('signs /t/<token> for item rows (72 h, item + member + actions)', () => {
    const t = createTestContext()
    const item = t.domain.sendRequest(t.as(t.husband), { toMemberId: t.wife.id, title: '带孩子出去' })
    const n = t.outbox.listForItem(item.id).find(x => x.kind === 'request_new')!
    const url = notificationLinkUrl('https://family.test', 'secret', n, t.clock.now())
    expect(url.startsWith('https://family.test/t/')).toBe(true)
    const token = url.slice('https://family.test/t/'.length)
    const payload = verifyLinkToken(token, 'secret', t.clock.now())
    const nowS = t.clock.now().getTime() / 1000
    expect(payload).toEqual({ i: item.id, m: t.wife.id, a: ['accept', 'decline', 'view'], e: nowS + 72 * 3600, t: nowS })
    expect(verifyLinkToken(token, 'secret', new Date(t.clock.now().getTime() + 73 * HOUR))).toBeNull()
    expect(verifyLinkToken(token, 'other', t.clock.now())).toBeNull()
  })

  it('links item-less rows to the in-app path', () => {
    const t = createTestContext()
    const n = t.outbox.enqueue({ memberId: t.wife.id, kind: 'weekly', title: '本周小结', body: 'x', url: '/weekly', dedupeKey: 'w' })!
    expect(notificationLinkUrl('https://family.test', 's', n, t.clock.now())).toBe('https://family.test/weekly')
  })

  it('actions for an item touched from WeChat', () => {
    const t = createTestContext()
    const req = t.domain.sendRequest(t.as(t.husband), { toMemberId: t.wife.id, title: '带孩子出去' })
    expect(linkActionsForItem(req, t.wife.id)).toEqual(['accept', 'decline', 'view'])
    expect(linkActionsForItem(req, t.husband.id)).toEqual(['view'])
    const task = t.domain.createItem(t.as(t.husband), { kind: 'task', title: '买地毯' })
    expect(linkActionsForItem(task, t.husband.id)).toEqual(['done', 'view'])
    expect(linkActionsForItem(t.domain.completeItem(t.as(t.husband), task.id), t.husband.id)).toEqual(['view'])
  })
})

describe('template data', () => {
  it('maps a notification to task / from / when / note', () => {
    const t = createTestContext()
    const item = t.domain.sendRequest(t.as(t.husband), {
      toMemberId: t.wife.id,
      title: '带孩子出去',
      details: '我九点有个会\n回来再说',
      dueAt: '2026-10-24T08:30+11:00',
    })
    const n = t.outbox.listForItem(item.id).find(x => x.kind === 'request_new')!
    const data = notificationTemplateData(n, { item, members: t.domain.listMembers(), now: t.clock.now(), tz: 'Australia/Sydney' })
    expect(data).toEqual({
      task: { value: '老公请你：带孩子出去' },
      from: { value: '老公' },
      when: { value: '周六 10/24 08:30' },
      note: { value: '周六 10/24 08:30 · 我九…' }, // 20 characters, spaces included
    })
    for (const f of Object.values(data)) expect(Array.from(f.value).length).toBeLessThanOrEqual(20)
  })

  it('uses 家庭助手 and the delivery time for item-less rows', () => {
    const t = createTestContext()
    const data = notificationTemplateData(
      { kind: 'digest', title: '今日摘要 · 10/21 周三', body: '今天要做 2 件，老婆在等你回复 1 件。修水龙头、交水费' },
      { item: null, members: t.domain.listMembers(), now: t.clock.now(), tz: 'Australia/Sydney' },
    )
    expect(data.from.value).toBe('家庭助手')
    expect(data.when.value).toBe('今天 12:00')
    expect(data.note.value).toBe('今天要做 2 件，老婆在等你回复 1…')
  })

  it('reply template: reply, 家庭助手, now, first change', () => {
    const t = createTestContext()
    expect(replyTemplateData({ reply: '好的，记下了：明天买牛奶 🥛', note: '新建待办：买牛奶（明天）', now: t.clock.now(), tz: 'Australia/Sydney' })).toEqual({
      task: { value: '好的，记下了：明天买牛奶' },
      from: { value: '家庭助手' },
      when: { value: '今天 12:00' },
      note: { value: '新建待办：买牛奶（明天）' },
    })
    expect(replyTemplateData({ reply: '', note: null, now: t.clock.now(), tz: 'Australia/Sydney' }).note.value).toBe('没有改动')
  })
})
