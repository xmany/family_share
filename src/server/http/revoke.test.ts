// Regression test: `npm run family -- revoke` (lost phone) used to sign the member's sessions out and cancel their own
// invites only. The phone kept the WeChat binding (texts acted as the member, reminders kept arriving with signed links),
// its push subscription (reminder text on the lock screen), the 72 h /t/ links, and the invites it had minted for other
// members or for new members it added.

import { describe, expect, it, vi } from 'vitest'
import { MINUTE } from '../time'
import { getOrCreateAppSecret, signLinkToken } from '../tokens'
import { signedItemUrl } from '../wechat/format'
import { bindWechatOpenid, consumeBindCode, createBindCode, findMemberIdByOpenid } from '../wechat/store'
import { revokeMemberAccess } from './revoke'
import { harness } from './testkit'

vi.mock('../wechat/index', () => ({
  handleWechatVerify: vi.fn(),
  handleWechatMessage: vi.fn(),
  rejectUnsignedWechatCallback: vi.fn(),
  createWechatBindCode: vi.fn(),
  getWechatBinding: vi.fn(() => ({ bound: false, mode: 'fallback' })),
}))

const inviteToken = (url: string) => url.split('#token=')[1]!

describe('revokeMemberAccess (lost phone)', () => {
  it('cuts every way in the phone has, and nothing of the other members', async () => {
    const h = harness()
    const { husband, wife } = h.t
    const db = h.t.db
    const now = () => h.t.clock.now()
    const secret = getOrCreateAppSecret(db)

    // what the husband's phone holds
    h.notifier.savePushSubscription(husband.id, { endpoint: 'https://push.example/husband', expirationTime: null, keys: { p256dh: 'p', auth: 'a' } })
    h.notifier.savePushSubscription(wife.id, { endpoint: 'https://push.example/wife', expirationTime: null, keys: { p256dh: 'p', auth: 'a' } })
    bindWechatOpenid(db, husband.id, 'o_husband', now())
    bindWechatOpenid(db, wife.id, 'o_wife', now())
    const { code } = createBindCode(db, husband.id, now())
    const item = h.t.domain.sendRequest(h.t.as(wife), { toMemberId: husband.id, title: '带孩子出去' })
    const link = (memberId: string) =>
      signedItemUrl('https://family.test', secret, { itemId: item.id, memberId, allowed: ['accept', 'decline', 'view'], now: now() }).split('/t/')[1]!
    const husbandLink = link(husband.id)
    const wifeLink = link(wife.id)
    // a link minted before links carried their issue time
    const legacyLink = signLinkToken({ i: item.id, m: husband.id, a: ['view'], e: Math.floor(now().getTime() / 1000) + 3600 }, secret)
    const ownInvite = h.inviteFor(husband)

    // whoever has the phone mints an invite for the wife and adds a new adult, keeping both links
    const forWife = await h.json('POST', `/api/members/${wife.id}/invite`, { as: husband })
    expect(forWife.status).toBe(200)
    const stranger = await h.json('POST', '/api/members', { as: husband, body: { name: '小王', role: 'adult' } })
    expect(stranger.status).toBe(200)
    expect((await h.json('GET', `/api/t/${husbandLink}`)).status).toBe(200)

    h.t.clock.advance(MINUTE)
    const r = revokeMemberAccess(db, h.t.clock, husband.id)
    expect(r).toMatchObject({ sessions: 1, invites: 1, pushDevices: 1, wechatUnbound: true, bindCodes: 1 })
    expect(r.createdInvites.map(i => [i.memberId, i.cancelled])).toEqual([
      [wife.id, true],
      [stranger.body.member.id, true],
    ])

    // the session, the WeChat binding and its pending bind code, push, and every link already sent
    expect((await h.json('GET', '/api/me', { as: husband })).status).toBe(401)
    expect(findMemberIdByOpenid(db, 'o_husband')).toBeNull()
    expect(consumeBindCode(db, code, now())).toBeNull()
    expect(h.notifier.pushSubscriptionCount(husband.id)).toBe(0)
    for (const token of [husbandLink, legacyLink]) {
      const g = await h.json('GET', `/api/t/${token}`)
      expect(g.status).toBe(401)
      expect(g.body.error.code).toBe('link_invalid')
    }
    expect((await h.json('POST', `/api/t/${husbandLink}/action`, { body: { action: 'accept' } })).status).toBe(401)
    expect(h.t.domain.getItem(item.id)!.status).toBe('pending')

    // the invites: his own, the one minted for the wife, the one for the member added from the phone
    for (const token of [ownInvite, inviteToken(forWife.body.inviteUrl), inviteToken(stranger.body.inviteUrl)]) {
      const j = await h.json('POST', '/api/auth/join', { body: { token } })
      expect(j.status).toBe(401)
      expect(j.body.error.code).toBe('invite_revoked')
    }

    // the wife keeps everything
    expect((await h.json('GET', '/api/me', { as: wife })).status).toBe(200)
    expect(findMemberIdByOpenid(db, 'o_wife')).toBe(wife.id)
    expect(h.notifier.pushSubscriptionCount(wife.id)).toBe(1)
    expect((await h.json('GET', `/api/t/${wifeLink}`)).status).toBe(200)

    // on the new phone: links sent after the revoke work again
    h.t.clock.advance(MINUTE)
    expect((await h.json('GET', `/api/t/${link(husband.id)}`)).status).toBe(200)
  })

  it('lists invites made earlier but no longer open without cancelling anything else', () => {
    const h = harness()
    const { husband, wife } = h.t
    const created = h.t.db.prepare('INSERT INTO invites (token_hash, member_id, created_by, created_at, expires_at, use_count) VALUES (?, ?, ?, ?, ?, ?)')
    const t = (offsetDays: number) => new Date(h.t.clock.now().getTime() + offsetDays * 86_400_000).toISOString()
    created.run('old-expired', wife.id, husband.id, t(-10), t(-3), 2)
    created.run('too-old', wife.id, husband.id, t(-40), t(-33), 1)
    const r = revokeMemberAccess(h.t.db, h.t.clock, husband.id)
    expect(r.createdInvites).toEqual([{ memberId: wife.id, createdAt: t(-10), useCount: 2, cancelled: false }])
    expect(r).toMatchObject({ sessions: 0, invites: 0, pushDevices: 0, wechatUnbound: false, bindCodes: 0 })
  })
})
