// zod schemas for every JSON body in src/shared/api.ts. They check shapes and sizes only; the domain
// enforces the business rules (title length after trimming, status transitions, HH:MM, …).
// Unknown keys are stripped. `null` is accepted wherever a field is optional and means "not given",
// except where the contract gives null a meaning (UpdateItemBody, digestTime).

import { z } from 'zod'
import { isLocalDate, zonedToUtc } from '../time'

/**
 * Parses an instant sent by the app (SnoozeBody.until) the way the domain parses dueAt: ISO 8601 with Z or an offset,
 * or a local "YYYY-MM-DD[T ]HH:MM[:SS]" read in the FAMILY timezone. Returns null for anything else — `new Date()` would
 * read other formats in the server's timezone and roll impossible dates over (2027-02-30 → March 2).
 */
export function parseInstant(value: string, tz: string): Date | null {
  const s = value.trim()
  const m = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,9})?)?(Z|[+-]\d{2}:?\d{2})?$/i.exec(s)
  if (!m) return null
  const [, date, hh, mm, ss, offset] = m
  if (!isLocalDate(date!) || Number(hh) > 23 || Number(mm) > 59 || Number(ss ?? 0) > 59) return null
  if (!offset) return zonedToUtc(date!, `${hh}:${mm}`, tz)
  const t = new Date(s.replace(' ', 'T'))
  return Number.isNaN(t.getTime()) ? null : t
}

const str = (max: number) => z.string().max(max)
const optStr = (max: number) =>
  z
    .string()
    .max(max)
    .nullish()
    .transform(v => v ?? undefined)

const KINDS = ['task', 'request', 'idea', 'reminder'] as const
const STATUSES = ['open', 'pending', 'accepted', 'declined', 'in_progress', 'blocked', 'done', 'dropped'] as const
const PRIORITIES = ['low', 'normal', 'high'] as const

export const joinSchema = z.object({ token: z.string().min(1).max(200) })

export const createItemSchema = z.object({
  kind: z.enum(KINDS),
  title: str(1000),
  details: optStr(4000),
  ownerId: optStr(100),
  dueAt: optStr(100),
  dueDate: optStr(20),
  priority: z
    .enum(PRIORITIES)
    .nullish()
    .transform(v => v ?? undefined),
})

export const updateItemSchema = z.object({
  kind: z.enum(['task', 'idea', 'reminder']).optional(),
  title: str(1000).optional(),
  details: str(4000).nullable().optional(),
  status: z.enum(STATUSES).optional(),
  ownerId: str(100).nullable().optional(),
  dueAt: str(100).nullable().optional(),
  dueDate: str(20).nullable().optional(),
  priority: z.enum(PRIORITIES).optional(),
})

export const respondSchema = z.object({
  response: z.enum(['accept', 'decline']),
  message: optStr(4000),
})

export const completeSchema = z.object({ note: optStr(4000) })

export const snoozeSchema = z
  .object({
    until: optStr(100),
    preset: z
      .enum(['tonight', 'tomorrow', 'weekend', 'next_week'])
      .nullish()
      .transform(v => v ?? undefined),
  })
  .refine(b => (b.until === undefined) !== (b.preset === undefined), { message: '请选择推迟到什么时候（until 或 preset 二选一）' })

export const noteSchema = z.object({ text: str(4000) })

export const utteranceSchema = z.object({
  text: z.string().trim().min(1).max(2000),
  source: z
    .enum(['text', 'clarification'])
    .nullish()
    .transform(v => v ?? undefined),
  replyToUtteranceId: optStr(100),
})

export const notificationActionSchema = z.object({
  action: z.enum(['accept', 'decline', 'done', 'snooze_tonight', 'snooze_tomorrow']),
})

export const pushSubscribeSchema = z.object({
  subscription: z.object({
    endpoint: z
      .string()
      .max(2000)
      .refine(v => /^https:\/\//.test(v), { message: '推送地址必须是 https' }),
    expirationTime: z.number().nullish(),
    keys: z.object({ p256dh: z.string().min(1).max(500), auth: z.string().min(1).max(500) }),
  }),
})

export const pushUnsubscribeSchema = z.object({ endpoint: z.string().min(1).max(2000) })

const channelSettingSchema = z.object({
  channel: z.string().min(1).max(40),
  enabled: z.boolean(),
  config: z.record(z.string(), z.string().max(500)).optional().default({}),
})

export const settingsSchema = z.object({
  name: str(100).optional(),
  aliases: z.array(str(100)).max(30).optional(),
  quietStart: str(10).optional(),
  quietEnd: str(10).optional(),
  digestTime: str(10).nullable().optional(),
  channels: z.array(channelSettingSchema).max(20).optional(),
})

export const newMemberSchema = z.object({
  name: str(100),
  aliases: z.array(str(100)).max(30).optional(),
  role: z.enum(['adult', 'kid', 'relative']),
})

export const linkActionSchema = z.object({
  action: z.enum(['accept', 'decline', 'done']),
  message: optStr(4000),
})
