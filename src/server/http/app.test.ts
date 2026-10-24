import { describe, expect, it, vi } from 'vitest'
import type { Item } from '../../shared/types'
import { sha256Hex } from '../ids'
import { DAY, MINUTE, resolveSnoozePreset } from '../time'
import { getOrCreateAppSecret, signLinkToken } from '../tokens'
import { INVITE_MAX_USES, revokeInvites } from './auth'
import { harness } from './testkit'

vi.mock('../wechat/index', () => ({
  handleWechatVerify: vi.fn((_ctx: unknown, q: Record<string, string>) => ({ status: q.signature === 'good' ? 200 : 403, body: q.signature === 'good' ? (q.echostr ?? '') : 'forbidden' })),
  handleWechatMessage: vi.fn(async (_ctx: unknown, _q: Record<string, string>, raw: string) => ({
    status: 200,
    body: `<xml><echo>${raw.length}</echo></xml>`,
    contentType: 'application/xml; charset=utf-8',
  })),
  rejectUnsignedWechatCallback: vi.fn((_ctx: unknown, q: Record<string, string>) =>
    q.signature === 'good' ? null : { status: 403, body: 'invalid signature', contentType: 'text/plain; charset=utf-8' },
  ),
  createWechatBindCode: vi.fn(() => ({ code: '482913', expiresAt: '2026-10-21T01:30:00.000Z', instructions: '关注测试号后，发送：绑定 482913' })),
  getWechatBinding: vi.fn(() => ({ bound: true, mode: 'both' })),
}))

const cookieValue = (setCookie: string | null) => /fs_session=([^;]+)/.exec(setCookie ?? '')?.[1] ?? null

describe('auth: invites and sessions', () => {
  it('join sets a hardened session cookie and the cookie authenticates', async () => {
    const h = harness()
    const token = h.inviteFor(h.t.wife)
    const r = await h.json('POST', '/api/auth/join', { body: { token } })
    expect(r.status).toBe(200)
    expect(r.body.me.id).toBe(h.t.wife.id)
    const sc = r.res.headers.get('set-cookie')!
    expect(sc).toMatch(/^fs_session=[A-Za-z0-9_-]{40,};/)
    expect(sc).toContain('Max-Age=34560000')
    expect(sc).toContain('Path=/')
    expect(sc).toContain('HttpOnly')
    expect(sc).toContain('Secure')
    expect(sc).toContain('SameSite=Lax')
    const raw = cookieValue(sc)!
    // only hashes are stored
    expect(h.t.db.prepare('SELECT COUNT(*) AS n FROM sessions WHERE token_hash = ?').get(sha256Hex(raw))).toEqual({ n: 1 })
    expect(h.t.db.prepare('SELECT COUNT(*) AS n FROM invites WHERE token_hash = ?').get(token)).toEqual({ n: 0 })
    const me = await h.json('GET', '/api/me', { cookie: `fs_session=${raw}` })
    expect(me.status).toBe(200)
    expect(me.body.me.name).toBe('老婆')
    expect(me.body.family).toEqual({ name: '测试家', timezone: 'Australia/Sydney' })
    expect(me.body.vapidPublicKey).toBe('BFakeVapidPublicKey')
    expect(me.body.sttEnabled).toBe(false)
    expect(me.body.channels).toEqual(['webpush'])
  })

  it('omits Secure when PUBLIC_URL is http', async () => {
    const h = harness({ config: { secureCookies: false, publicUrl: 'http://localhost:5173' } })
    const r = await h.req('POST', '/api/auth/join', { body: { token: h.inviteFor(h.t.husband) } })
    expect(r.status).toBe(200)
    expect(r.headers.get('set-cookie')).not.toContain('Secure')
  })

  it(`an invite works ${INVITE_MAX_USES} times, then is used up`, async () => {
    const h = harness()
    const token = h.inviteFor(h.t.husband)
    for (let i = 0; i < INVITE_MAX_USES; i++) {
      expect((await h.req('POST', '/api/auth/join', { body: { token } })).status).toBe(200)
    }
    const r = await h.json('POST', '/api/auth/join', { body: { token } })
    expect(r.status).toBe(401)
    expect(r.body.error.code).toBe('invite_used_up')
    expect(r.body.error.message).toMatch(/邀请链接/)
  })

  it('rejects expired, revoked and unknown invites; GET never consumes one', async () => {
    const h = harness()
    const token = h.inviteFor(h.t.wife)
    expect((await h.req('GET', '/api/auth/join')).status).toBe(404)
    expect((await h.req('GET', `/join#token=${token}`)).status).toBe(404) // no web build in this harness
    expect(h.t.db.prepare('SELECT use_count FROM invites').get()).toEqual({ use_count: 0 })

    h.t.clock.advance(7 * DAY + MINUTE)
    let r = await h.json('POST', '/api/auth/join', { body: { token } })
    expect(r.status).toBe(401)
    expect(r.body.error.code).toBe('invite_expired')

    const token2 = h.inviteFor(h.t.wife)
    expect(revokeInvites(h.t.db, h.t.clock, h.t.wife.id)).toBe(1)
    r = await h.json('POST', '/api/auth/join', { body: { token: token2 } })
    expect(r.body.error.code).toBe('invite_revoked')

    r = await h.json('POST', '/api/auth/join', { body: { token: 'nope' } })
    expect(r.status).toBe(401)
    expect(r.body.error.code).toBe('invite_unknown')

    r = await h.json('POST', '/api/auth/join', { body: {} })
    expect(r.status).toBe(400)
    expect(r.body.error.code).toBe('invalid')
    expect(r.body.error.message).toContain('邀请码')
  })

  it('401 JSON without a valid session; logout revokes the session', async () => {
    const h = harness()
    for (const path of ['/api/me', '/api/board', '/api/items/i_x', '/api/settings', '/api/stream', '/api/nope']) {
      const r = await h.json('GET', path)
      expect(r.status, path).toBe(401)
      expect(r.body.error.code).toBe('unauthorized')
    }
    expect((await h.req('GET', '/api/board', { cookie: 'fs_session=forged' })).status).toBe(401)

    const cookie = h.cookieFor(h.t.husband)
    expect((await h.req('GET', '/api/board', { cookie })).status).toBe(200)
    const out = await h.req('POST', '/api/auth/logout', { cookie })
    expect(out.status).toBe(200)
    expect(out.headers.get('set-cookie')).toMatch(/fs_session=;.*Max-Age=0/)
    expect((await h.req('GET', '/api/board', { cookie })).status).toBe(401)
  })

  it('sessions expire after 400 days without use', async () => {
    const h = harness()
    const cookie = h.cookieFor(h.t.husband)
    h.t.clock.advance(399 * DAY)
    expect((await h.req('GET', '/api/me', { cookie })).status).toBe(200)
    h.t.clock.advance(399 * DAY) // still alive: the previous request refreshed last_seen_at
    expect((await h.req('GET', '/api/me', { cookie })).status).toBe(200)
    h.t.clock.advance(401 * DAY)
    expect((await h.req('GET', '/api/me', { cookie })).status).toBe(401)
  })

  it('updates last_seen_at at most every 5 minutes and re-issues the cookie with it', async () => {
    const h = harness()
    const cookie = h.cookieFor(h.t.husband)
    const seen = () => (h.t.db.prepare('SELECT last_seen_at AS t FROM sessions').get() as { t: string }).t
    const t0 = seen()
    h.t.clock.advance(4 * MINUTE)
    let r = await h.req('GET', '/api/me', { cookie })
    expect(seen()).toBe(t0)
    expect(r.headers.get('set-cookie')).toBeNull()
    h.t.clock.advance(2 * MINUTE)
    r = await h.req('GET', '/api/me', { cookie })
    expect(seen()).toBe(h.t.clock.now().toISOString())
    expect(r.headers.get('set-cookie')).toContain('Max-Age=34560000')
  })

  it('403 on mutations without the X-Family-Share header (join included)', async () => {
    const h = harness()
    let r = await h.json('POST', '/api/items', { as: h.t.husband, csrf: false, body: { kind: 'task', title: '买牛奶' } })
    expect(r.status).toBe(403)
    expect(r.body.error.code).toBe('forbidden')
    r = await h.json('POST', '/api/auth/join', { csrf: false, body: { token: h.inviteFor(h.t.wife) } })
    expect(r.status).toBe(403)
    for (const [m, p] of [
      ['PATCH', '/api/items/i_x'],
      ['PUT', '/api/settings'],
      ['DELETE', '/api/push/subscriptions'],
    ] as const) {
      expect((await h.req(m, p, { as: h.t.husband, csrf: false, body: {} })).status).toBe(403)
    }
    expect((await h.req('POST', '/api/items', { as: h.t.husband, headers: { 'X-Family-Share': '0' }, body: {} })).status).toBe(403)
    expect(h.t.domain.listActiveItems()).toHaveLength(0)
  })
})

describe('board and items', () => {
  it('board, create, detail, update; tolerates unknown query params', async () => {
    const h = harness()
    const as = h.t.husband
    const created = await h.json('POST', '/api/items', { as, body: { kind: 'task', title: '买地毯', dueDate: '2026-10-24', priority: 'high' } })
    expect(created.status).toBe(200)
    const item: Item = created.body.item
    expect(item).toMatchObject({ kind: 'task', title: '买地毯', ownerId: as.id, dueDate: '2026-10-24', priority: 'high', status: 'open' })

    const board = await h.json('GET', '/api/board?from=singlemessage&isappinstalled=0', { as })
    expect(board.status).toBe(200)
    expect(board.body.me.id).toBe(as.id)
    expect(board.body.members.map((m: { name: string }) => m.name)).toEqual(['老公', '老婆'])
    expect(board.body.items.map((i: Item) => i.id)).toEqual([item.id])
    expect(board.body.serverTime).toBe('2026-10-21T01:00:00.000Z')

    const detail = await h.json('GET', `/api/items/${item.id}`, { as })
    expect(detail.body.item.id).toBe(item.id)
    expect(detail.body.events[0].type).toBe('item_created')

    const patched = await h.json('PATCH', `/api/items/${item.id}`, { as, body: { title: '买客厅地毯', details: null, dueAt: '2026-10-24T08:30' } })
    expect(patched.status).toBe(200)
    expect(patched.body.item).toMatchObject({ title: '买客厅地毯', dueDate: null, dueAt: '2026-10-23T21:30:00.000Z' })
    expect(h.t.events.some(e => e.type === 'board_changed')).toBe(true)
  })

  it('maps zod and DomainError failures to 400/404 with Chinese messages', async () => {
    const h = harness()
    const as = h.t.husband
    let r = await h.json('POST', '/api/items', { as, body: { kind: 'chore', title: 'x' } })
    expect(r.status).toBe(400)
    expect(r.body.error).toEqual({ code: 'invalid', message: expect.stringContaining('类型') })
    r = await h.json('POST', '/api/items', { as, body: '{not json' })
    expect(r.status).toBe(400)
    r = await h.json('POST', '/api/items', { as, body: { kind: 'task', title: '   ' } })
    expect(r.status).toBe(400)
    expect(r.body.error.code).toBe('invalid')
    expect(r.body.error.message).toMatch(/[一-鿿]/)
    r = await h.json('GET', '/api/items/i_missing', { as })
    expect(r.status).toBe(404)
    expect(r.body.error.code).toBe('not_found')
    r = await h.json('PATCH', '/api/items/i_missing', { as, body: { title: '新标题' } })
    expect(r.status).toBe(404)
    r = await h.json('POST', '/api/items', { as, body: { kind: 'request', title: '带孩子' } })
    expect(r.status).toBe(400)
  })

  it('request lifecycle: send, forbidden respond by the asker, accept, complete', async () => {
    const h = harness()
    const { husband, wife } = h.t
    const sent = await h.json('POST', '/api/items', { as: husband, body: { kind: 'request', title: '带孩子出去', ownerId: wife.id, dueAt: '2026-10-24T08:30' } })
    expect(sent.status).toBe(200)
    const id = sent.body.item.id
    expect(sent.body.item).toMatchObject({ kind: 'request', status: 'pending', ownerId: wife.id, requestedBy: husband.id })

    let r = await h.json('POST', `/api/items/${id}/respond`, { as: husband, body: { response: 'accept' } })
    expect(r.status).toBe(403)
    expect(r.body.error.code).toBe('forbidden')

    r = await h.json('POST', `/api/items/${id}/respond`, { as: wife, body: { response: 'accept', message: '没问题' } })
    expect(r.status).toBe(200)
    expect(r.body.item.status).toBe('accepted')

    r = await h.json('POST', `/api/items/${id}/respond`, { as: wife, body: { response: 'maybe' } })
    expect(r.status).toBe(400)

    r = await h.json('POST', `/api/items/${id}/complete`, { as: wife })
    expect(r.status).toBe(200)
    expect(r.body.item.status).toBe('done')
    expect(r.body.item.completedAt).toBe(h.t.clock.now().toISOString())
  })

  it('snooze by preset (family timezone) or instant, and notes', async () => {
    const h = harness()
    const as = h.t.husband
    const { body } = await h.json('POST', '/api/items', { as, body: { kind: 'task', title: '修柜子' } })
    const id = body.item.id
    let r = await h.json('POST', `/api/items/${id}/snooze`, { as, body: { preset: 'tomorrow' } })
    expect(r.status).toBe(200)
    expect(r.body.item.snoozedUntil).toBe(resolveSnoozePreset('tomorrow', h.t.clock.now(), 'Australia/Sydney').toISOString())
    expect(r.body.item.snoozedUntil).toBe('2026-10-21T22:00:00.000Z') // Thu 09:00 Sydney

    r = await h.json('POST', `/api/items/${id}/snooze`, { as, body: { until: '2026-10-25T00:00:00.000Z' } })
    expect(r.body.item.snoozedUntil).toBe('2026-10-25T00:00:00.000Z')
    r = await h.json('POST', `/api/items/${id}/snooze`, { as, body: { until: '2026-10-25T00:00:00.000Z', preset: 'tonight' } })
    expect(r.status).toBe(400)
    r = await h.json('POST', `/api/items/${id}/snooze`, { as, body: {} })
    expect(r.status).toBe(400)

    r = await h.json('POST', `/api/items/${id}/notes`, { as, body: { text: '需要买合页' } })
    expect(r.status).toBe(200)
    expect(r.body.item.id).toBe(id)
    const detail = await h.json('GET', `/api/items/${id}`, { as })
    expect(detail.body.notes.map((n: { text: string }) => n.text)).toEqual(['需要买合页'])
  })
})

describe('utterances', () => {
  it('interprets text, then undo reverts it (and a second undo is a 409)', async () => {
    const h = harness()
    const as = h.t.wife
    const r = await h.json('POST', '/api/utterances', { as, body: { text: '  明天买菜  ' } })
    expect(r.status).toBe(200)
    expect(h.interpreter.calls).toEqual([{ memberId: as.id, text: '明天买菜', source: 'text', replyToUtteranceId: null }])
    const uid = r.body.utterance.id
    expect(r.body.items[0].title).toBe('明天买菜')

    const clar = await h.json('POST', '/api/utterances', { as, body: { text: '周六', replyToUtteranceId: uid } })
    expect(clar.status).toBe(200)
    expect(h.interpreter.calls[1]!.source).toBe('clarification')

    const undo = await h.json('POST', `/api/utterances/${uid}/undo`, { as })
    expect(undo.status).toBe(200)
    expect(undo.body.utterance.status).toBe('undone')
    expect(h.t.domain.getItem(r.body.items[0].id)).toBeNull()
    const again = await h.json('POST', `/api/utterances/${uid}/undo`, { as })
    expect(again.status).toBe(409)
    expect(again.body.error.code).toBe('conflict')

    expect((await h.json('POST', '/api/utterances', { as, body: { text: '   ' } })).status).toBe(400)
  })
})

describe('notification actions (service worker buttons)', () => {
  it("only the recipient can act; another member's notification is a 404", async () => {
    const h = harness()
    const { husband, wife } = h.t
    const { body } = await h.json('POST', '/api/items', { as: husband, body: { kind: 'request', title: '倒垃圾', ownerId: wife.id } })
    const itemId = body.item.id
    const n = h.t.outbox.scheduledForItem(itemId).find(x => x.kind === 'request_new')!
    expect(n.memberId).toBe(wife.id)

    let r = await h.json('POST', `/api/notifications/${n.id}/action`, { as: husband, body: { action: 'accept' } })
    expect(r.status).toBe(404)
    expect(h.t.domain.getItem(itemId)!.status).toBe('pending')
    r = await h.json('POST', '/api/notifications/nt_missing/action', { as: wife, body: { action: 'accept' } })
    expect(r.status).toBe(404)
    r = await h.json('POST', `/api/notifications/${n.id}/action`, { as: wife, body: { action: 'open' } })
    expect(r.status).toBe(400)

    r = await h.json('POST', `/api/notifications/${n.id}/action`, { as: wife, body: { action: 'accept' } })
    expect(r.status).toBe(200)
    expect(r.body).toEqual({ ok: true })
    expect(h.t.domain.getItem(itemId)!.status).toBe('accepted')
    // a repeated tap is harmless
    expect((await h.req('POST', `/api/notifications/${n.id}/action`, { as: wife, body: { action: 'accept' } })).status).toBe(200)

    r = await h.json('POST', `/api/notifications/${n.id}/action`, { as: wife, body: { action: 'snooze_tonight' } })
    expect(r.status).toBe(200)
    expect(h.t.domain.getItem(itemId)!.snoozedUntil).toBe(resolveSnoozePreset('tonight', h.t.clock.now(), 'Australia/Sydney').toISOString())

    r = await h.json('POST', `/api/notifications/${n.id}/action`, { as: wife, body: { action: 'done' } })
    expect(r.status).toBe(200)
    expect(h.t.domain.getItem(itemId)!.status).toBe('done')
  })
})

describe('signed links /api/t/:token', () => {
  function setup() {
    const h = harness()
    const { husband, wife } = h.t
    const item = h.t.domain.sendRequest(h.t.as(husband), { toMemberId: wife.id, title: '接孩子' })
    const secret = getOrCreateAppSecret(h.t.db)
    const e = Math.floor(h.t.clock.now().getTime() / 1000) + 72 * 3600
    const token = signLinkToken({ i: item.id, m: wife.id, a: ['view', 'accept', 'decline'], e }, secret)
    return { h, item, token, secret, e }
  }

  it('views without a session and lists only applicable actions', async () => {
    const { h, item, token } = setup()
    const r = await h.json('GET', `/api/t/${token}?from=singlemessage`)
    expect(r.status).toBe(200)
    expect(r.body.item.id).toBe(item.id)
    expect(r.body.memberId).toBe(h.t.wife.id)
    expect(r.body.allowed).toEqual(['accept', 'decline'])
    expect(r.body.members).toHaveLength(2)
    expect(r.body.family.timezone).toBe('Australia/Sydney')
  })

  it('performs an allowed action as the link member and refuses others', async () => {
    const { h, item, token } = setup()
    let r = await h.json('POST', `/api/t/${token}/action`, { body: { action: 'done' } })
    expect(r.status).toBe(403)
    expect(r.body.error.code).toBe('forbidden')
    r = await h.json('POST', `/api/t/${token}/action`, { csrf: false, body: { action: 'accept' } })
    expect(r.status).toBe(403)

    r = await h.json('POST', `/api/t/${token}/action`, { body: { action: 'accept', message: '好' } })
    expect(r.status).toBe(200)
    expect(r.body.item.status).toBe('accepted')
    expect(r.body.allowed).toEqual([])
    const ev = h.t.domain.getItemDetail(item.id)!.events.find(e => e.type === 'request_responded')!
    expect(ev.memberId).toBe(h.t.wife.id)
    expect(ev.actorType).toBe('member')
  })

  it('rejects expired, tampered and foreign-secret tokens', async () => {
    const { h, item, secret, e } = setup()
    const expired = signLinkToken({ i: item.id, m: h.t.wife.id, a: ['view', 'done'], e: e - 73 * 3600 }, secret)
    let r = await h.json('GET', `/api/t/${expired}`)
    expect(r.status).toBe(401)
    expect(r.body.error.code).toBe('link_invalid')
    const foreign = signLinkToken({ i: item.id, m: h.t.wife.id, a: ['view', 'done'], e }, 'other-secret')
    expect((await h.req('GET', `/api/t/${foreign}`)).status).toBe(401)
    expect((await h.req('GET', '/api/t/garbage')).status).toBe(401)
    r = await h.json('POST', `/api/t/${expired}/action`, { body: { action: 'done' } })
    expect(r.status).toBe(401)
    const missing = signLinkToken({ i: 'i_gone', m: h.t.wife.id, a: ['view'], e }, secret)
    expect((await h.req('GET', `/api/t/${missing}`)).status).toBe(404)
  })
})

describe('family members', () => {
  it('adults create members with an invite link that works; kids are refused', async () => {
    const h = harness()
    const r = await h.json('POST', '/api/members', { as: h.t.husband, body: { name: '外婆', aliases: ['姥姥'], role: 'relative' } })
    expect(r.status).toBe(200)
    expect(r.body.member).toMatchObject({ name: '外婆', aliases: ['姥姥'], role: 'relative' })
    expect(r.body.inviteUrl).toMatch(/^https:\/\/family\.test\/join#token=[A-Za-z0-9_-]+$/)
    expect(r.body.expiresAt).toBe(new Date(h.t.clock.now().getTime() + 7 * DAY).toISOString())
    const token = r.body.inviteUrl.split('#token=')[1]
    const joined = await h.json('POST', '/api/auth/join', { body: { token } })
    expect(joined.body.me.name).toBe('外婆')

    const kid = h.t.domain.createMember({ name: '小明', role: 'kid' })
    let k = await h.json('POST', '/api/members', { as: kid, body: { name: '小红', role: 'kid' } })
    expect(k.status).toBe(403)
    k = await h.json('POST', `/api/members/${h.t.wife.id}/invite`, { as: kid })
    expect(k.status).toBe(403)

    const inv = await h.json('POST', `/api/members/${h.t.wife.id}/invite`, { as: h.t.husband })
    expect(inv.status).toBe(200)
    expect(inv.body.member.id).toBe(h.t.wife.id)
    expect((await h.req('POST', '/api/members/m_missing/invite', { as: h.t.husband })).status).toBe(404)

    const list = await h.json('GET', '/api/members', { as: kid })
    expect(list.body.members.map((m: { name: string }) => m.name)).toEqual(['老公', '老婆', '外婆', '小明'])
    // duplicate names are a domain error
    expect((await h.req('POST', '/api/members', { as: h.t.husband, body: { name: '老婆', role: 'adult' } })).status).toBe(400)
  })
})

describe('settings, push and WeChat binding', () => {
  it('round-trips settings', async () => {
    const h = harness()
    const as = h.t.husband
    let r = await h.json('GET', '/api/settings', { as })
    expect(r.status).toBe(200)
    expect(r.body).toMatchObject({
      me: { id: as.id, quietStart: '22:00', quietEnd: '07:30', digestTime: '07:30' },
      pushDevices: 0,
      pushHealthy: false,
      wechat: { available: false, bound: true, mode: 'both', followQrUrl: null },
    })
    r = await h.json('PUT', '/api/settings', {
      as,
      body: {
        name: '孩子爸',
        aliases: ['他', '爸爸'],
        quietStart: '23:00',
        quietEnd: '07:00',
        digestTime: null,
        channels: [{ channel: 'wechat', enabled: true, config: { mode: 'only' } }],
      },
    })
    expect(r.status).toBe(200)
    expect(r.body.me).toMatchObject({ name: '孩子爸', aliases: ['他', '爸爸'], quietStart: '23:00', quietEnd: '07:00', digestTime: null })
    expect(r.body.channels).toEqual([{ channel: 'wechat', enabled: true, config: { mode: 'only' } }])
    const again = await h.json('GET', '/api/settings', { as })
    expect(again.body).toEqual(r.body)
    r = await h.json('PUT', '/api/settings', { as, body: { quietStart: '25:99' } })
    expect(r.status).toBe(400)
  })

  it('push subscriptions belong to their member; test push reports delivered devices', async () => {
    const h = harness()
    const { husband, wife } = h.t
    const sub = { endpoint: 'https://push.example.com/abc', expirationTime: null, keys: { p256dh: 'p', auth: 'a' } }
    expect((await h.json('GET', '/api/push/vapid-public-key', { as: wife })).body).toEqual({ key: 'BFakeVapidPublicKey' })
    expect((await h.req('POST', '/api/push/subscriptions', { as: wife, body: { subscription: { ...sub, endpoint: 'http://insecure' } } })).status).toBe(400)
    expect((await h.json('POST', '/api/push/subscriptions', { as: wife, body: { subscription: sub } })).body).toEqual({ ok: true })
    let s = await h.json('GET', '/api/settings', { as: wife })
    expect(s.body.pushDevices).toBe(1)
    expect(s.body.pushHealthy).toBe(true)
    expect((await h.req('DELETE', '/api/push/subscriptions', { as: husband, body: { endpoint: sub.endpoint } })).status).toBe(404)
    expect(h.notifier.pushSubscriptionCount(wife.id)).toBe(1)

    const t = await h.json('POST', '/api/push/test', { as: wife })
    expect(t.status).toBe(200)
    expect(t.body).toEqual({ ok: true, delivered: 2 })
    expect(h.scheduler.ticks).toBe(1)
    const row = h.t.db.prepare(`SELECT kind, member_id, respect_quiet_hours, status FROM notifications WHERE kind = 'test'`).get()
    expect(row).toEqual({ kind: 'test', member_id: wife.id, respect_quiet_hours: 0, status: 'sent' })

    expect((await h.json('DELETE', '/api/push/subscriptions', { as: wife, body: { endpoint: sub.endpoint } })).body).toEqual({ ok: true })
    s = await h.json('GET', '/api/settings', { as: wife })
    expect(s.body.pushDevices).toBe(0)
  })

  it('bind code needs WeChat configured', async () => {
    let h = harness()
    let r = await h.json('POST', '/api/wechat/bind-code', { as: h.t.wife })
    expect(r.status).toBe(409)
    h = harness({
      config: { wechat: { appId: 'wx', appSecret: 's', token: 't', templateId: 'tpl', followQrUrl: 'https://example.com/qr.png' } },
    })
    r = await h.json('POST', '/api/wechat/bind-code', { as: h.t.wife })
    expect(r.status).toBe(200)
    expect(r.body.code).toBe('482913')
    const s = await h.json('GET', '/api/settings', { as: h.t.wife })
    expect(s.body.wechat).toEqual({ available: true, bound: true, mode: 'both', followQrUrl: 'https://example.com/qr.png' })
  })
})

describe('WeChat callback and health', () => {
  it('/wechat/mp needs no session or CSRF header and passes the raw body through', async () => {
    const h = harness()
    let r = await h.req('GET', '/wechat/mp?signature=good&timestamp=1&nonce=2&echostr=hello')
    expect(r.status).toBe(200)
    expect(await r.text()).toBe('hello')
    r = await h.req('GET', '/wechat/mp?signature=bad')
    expect(r.status).toBe(403)
    const xml = '<xml><MsgType><![CDATA[text]]></MsgType></xml>'
    r = await h.req('POST', '/wechat/mp?signature=good&openid=o1', { csrf: false, body: xml, headers: { 'Content-Type': 'text/xml' } })
    expect(r.status).toBe(200)
    expect(r.headers.get('content-type')).toContain('application/xml')
    expect(await r.text()).toBe(`<xml><echo>${xml.length}</echo></xml>`)
  })

  it('/healthz is public', async () => {
    const h = harness()
    const r = await h.json('GET', '/healthz?probe=1')
    expect(r.status).toBe(200)
    expect(r.body).toEqual({ ok: true })
  })
})
