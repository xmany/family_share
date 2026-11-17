// What the model is shown depends on the chat: the reply to a family utterance is read by everyone, so nothing
// said in private (by anyone) may be in its context; a private utterance also sees the speaker's own private chat.

import { describe, expect, it } from 'vitest'
import { testConfig } from '../config'
import { createTestContext } from '../testing'
import { createInterpreter } from './index'
import { SYSTEM_PROMPT } from './prompt'
import { gatherSnapshot, renderTurnInput } from './snapshot'
import { msg, ScriptedApi, type ScriptStep, text, toolUse } from './testing'

function setup(script: ScriptStep[]) {
  const t = createTestContext()
  const api = new ScriptedApi(script)
  const config = testConfig({ familyTimezone: t.family.timezone, anthropic: { ...t.config.anthropic, maxIterations: 6 } })
  const interpreter = createInterpreter({ config, domain: t.domain, clock: t.clock, api })
  return { t, api, interpreter }
}

const ok = () => msg('end_turn', [text('好')])

describe('interpret: the private chat', () => {
  it('records a private utterance and tells the model which channel it is in', async () => {
    const { t, api, interpreter } = setup([ok(), ok()])
    const r = await interpreter.interpret({ memberId: t.wife.id, text: '提醒我买礼物', source: 'text', visibility: 'private' })
    expect(r.utterance.visibility).toBe('private')
    expect(api.turnInput(0)).toContain('\nchannel: private（只有说话人和你能看到这句话和你的回复）\n')

    const f = await interpreter.interpret({ memberId: t.wife.id, text: '周六去公园', source: 'text' })
    expect(f.utterance.visibility).toBe('family')
    expect(api.turnInput(1)).toContain('\nchannel: family（全家人都能看到这句话和你的回复）\n')
    expect(SYSTEM_PROMPT).toContain('The channel line says who reads this conversation')
  })

  it("a family turn never sees private lines — not another member's, not the speaker's own", async () => {
    const { t, api, interpreter } = setup([ok(), ok(), ok(), ok()])
    await interpreter.interpret({ memberId: t.wife.id, text: '老婆的惊喜计划', source: 'text', visibility: 'private' })
    t.clock.advance(1000)
    await interpreter.interpret({ memberId: t.husband.id, text: '老公的秘密', source: 'text', visibility: 'private' })
    t.clock.advance(1000)
    await interpreter.interpret({ memberId: t.husband.id, text: '周六去公园', source: 'text' })
    t.clock.advance(1000)
    await interpreter.interpret({ memberId: t.wife.id, text: '好的', source: 'text' })
    const input = api.turnInput(3)
    expect(input).toContain('老公：周六去公园')
    expect(input).not.toContain('惊喜计划')
    expect(input).not.toContain('秘密')
    expect(input).not.toContain('私聊')
  })

  it("a private turn sees the family chat and the speaker's own private lines (marked), never another member's", async () => {
    const { t, api, interpreter } = setup([ok(), ok(), ok(), ok()])
    await interpreter.interpret({ memberId: t.husband.id, text: '周六去公园', source: 'text' })
    t.clock.advance(1000)
    await interpreter.interpret({ memberId: t.husband.id, text: '老公的秘密', source: 'text', visibility: 'private' })
    t.clock.advance(1000)
    await interpreter.interpret({ memberId: t.wife.id, text: '老婆的惊喜计划', source: 'text', visibility: 'private' })
    t.clock.advance(1000)
    await interpreter.interpret({ memberId: t.wife.id, text: '那个改到周日', source: 'text', visibility: 'private' })
    const input = api.turnInput(3)
    expect(input).toContain('老公：周六去公园 → 助手：好')
    expect(input).toContain('老婆（私聊）：老婆的惊喜计划 → 助手：好')
    expect(input).not.toContain('秘密')
  })

  it('a clarification in the private chat is answered in the private chat', async () => {
    const { t, api, interpreter } = setup([
      msg('tool_use', [toolUse('t1', 'ask_clarification', { question: '订哪一家？', options: ['川菜', '粤菜'] })]),
      ok(),
    ])
    const q = await interpreter.interpret({ memberId: t.wife.id, text: '订个餐厅给老公过生日', source: 'text', visibility: 'private' })
    expect(q.utterance).toMatchObject({ status: 'clarify', visibility: 'private' })
    const a = await interpreter.interpret({ memberId: t.wife.id, text: '川菜', source: 'clarification', visibility: 'private', replyToUtteranceId: q.utterance.id })
    expect(a.utterance.visibility).toBe('private')
    expect(api.turnInput(1)).toContain('<answering_clarification>\n老婆原话: 订个餐厅给老公过生日\n你问: 订哪一家？')
    expect(t.domain.recentUtterances(10)).toEqual([])
  })

  it("naming someone's private utterance as the question does not put it in front of the model", async () => {
    const { t, api, interpreter } = setup([
      msg('tool_use', [toolUse('t1', 'ask_clarification', { question: '订哪一家？', options: ['川菜', '粤菜'] })]),
      ok(),
      ok(),
    ])
    const q = await interpreter.interpret({ memberId: t.wife.id, text: '订个餐厅给老公过生日', source: 'text', visibility: 'private' })

    // the husband "answers" it — in the family chat, then in his own private chat
    for (const [n, visibility] of [
      [1, 'family'],
      [2, 'private'],
    ] as const) {
      const r = await interpreter.interpret({ memberId: t.husband.id, text: '第一个', source: 'clarification', visibility, replyToUtteranceId: q.utterance.id })
      // what he said is still recorded, just not linked to her question
      expect(r.utterance).toMatchObject({ memberId: t.husband.id, text: '第一个', visibility, status: 'done' })
      const input = api.turnInput(n)
      expect(input).not.toContain('answering_clarification')
      expect(input).not.toContain('过生日')
      expect(input).not.toContain('订哪一家')
    }
  })

  it('her own private question is not quoted into a family turn either', async () => {
    const { t, api, interpreter } = setup([
      msg('tool_use', [toolUse('t1', 'ask_clarification', { question: '订哪一家？', options: ['川菜', '粤菜'] })]),
      ok(),
    ])
    const q = await interpreter.interpret({ memberId: t.wife.id, text: '订个餐厅给老公过生日', source: 'text', visibility: 'private' })
    await interpreter.interpret({ memberId: t.wife.id, text: '川菜', source: 'clarification', replyToUtteranceId: q.utterance.id })
    expect(api.turnInput(1)).not.toContain('过生日')
    expect(api.turnInput(1)).not.toContain('answering_clarification')
  })
})

describe('gatherSnapshot', () => {
  it('drops an answering utterance that is not part of this chat even when asked for it directly', () => {
    const t = createTestContext()
    const secret = t.domain.createUtterance(t.wife.id, 'text', '订个餐厅给老公过生日', { visibility: 'private' })
    t.domain.finishUtterance(secret.id, { status: 'clarify', reply: '订哪一家？', clarification: { question: '订哪一家？', options: ['川菜', '粤菜'] } })
    const base = { now: t.clock.now(), text: '第一个', source: 'clarification' as const, currentUtteranceId: 'u_none', replyToUtteranceId: secret.id }

    expect(gatherSnapshot(t.domain, { ...base, speaker: t.husband }).answering).toBeNull()
    expect(gatherSnapshot(t.domain, { ...base, speaker: t.husband, visibility: 'private' }).answering).toBeNull()
    expect(gatherSnapshot(t.domain, { ...base, speaker: t.wife }).answering).toBeNull()
    const own = gatherSnapshot(t.domain, { ...base, speaker: t.wife, visibility: 'private' })
    expect(own.answering?.id).toBe(secret.id)
    expect(renderTurnInput(own)).toContain('老婆原话: 订个餐厅给老公过生日')
  })
})
