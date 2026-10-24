import { describe, expect, it } from 'vitest'
import { parseToolCall, SCHEMAS, TOOLS } from './tools'

describe('tool schemas stay inside strict-mode limits', () => {
  it('all strict, additionalProperties:false, <=20 tools, <=24 optional params, no unions or unsupported keywords', () => {
    let optional = 0
    let unions = 0
    const unsupported: string[] = []
    const walk = (schema: Record<string, unknown>, path: string) => {
      for (const k of ['minimum', 'maximum', 'minLength', 'maxLength', 'multipleOf', 'pattern', 'minItems', 'maxItems']) {
        if (k in schema) unsupported.push(`${path}.${k}`)
      }
      expect(schema.type, path).not.toBeUndefined()
      expect(Array.isArray(schema.type) || 'anyOf' in schema || 'oneOf' in schema, `${path} is a union`).toBe(false)
      if (schema.type === 'object') {
        expect(schema.additionalProperties, path).toBe(false)
        const props = (schema.properties ?? {}) as Record<string, Record<string, unknown>>
        const req = new Set((schema.required ?? []) as string[])
        for (const r of req) expect(props, `${path} requires unknown ${r}`).toHaveProperty(r)
        for (const [k, v] of Object.entries(props)) {
          if (!req.has(k)) optional++
          if (Array.isArray(v.type) || v.anyOf) unions++
          expect(typeof v.description === 'string' && v.description.length > 0, `${path}.${k} has a description`).toBe(true)
          walk(v, `${path}.${k}`)
        }
      }
      if (schema.type === 'array' && schema.items) walk(schema.items as Record<string, unknown>, `${path}[]`)
    }
    for (const t of TOOLS) {
      expect(t.strict).toBe(true)
      expect(t.description!.length).toBeGreaterThan(40)
      walk(t.input_schema as unknown as Record<string, unknown>, t.name)
    }
    expect(unsupported).toEqual([])
    expect(TOOLS.length).toBeLessThanOrEqual(20)
    expect(optional).toBeLessThanOrEqual(24)
    expect(unions).toBeLessThanOrEqual(16)
  })

  it('has exactly the SPEC §4 tools, and a zod schema with the same fields for each', () => {
    expect(TOOLS.map(t => t.name)).toEqual([
      'search_items',
      'create_item',
      'update_item',
      'add_note',
      'send_request',
      'respond_to_request',
      'complete_item',
      'snooze_item',
      'set_reminder',
      'cancel_reminder',
      'ask_clarification',
    ])
    for (const t of TOOLS) {
      const zodKeys = Object.keys(SCHEMAS[t.name as keyof typeof SCHEMAS].shape).sort()
      const wireKeys = Object.keys((t.input_schema as { properties: object }).properties).sort()
      expect(zodKeys, t.name).toEqual(wireKeys)
    }
  })

  it('is byte-stable (a module constant, never rebuilt)', async () => {
    const again = await import('./tools')
    expect(again.TOOLS).toBe(TOOLS)
    expect(JSON.stringify(TOOLS)).toBe(JSON.stringify(again.TOOLS))
  })
})

describe('parseToolCall', () => {
  it('accepts a valid call and normalizes enum casing', () => {
    const r = parseToolCall('complete_item', { item_id: 'i_abcdefghij', resolution: 'Dropped' })
    expect(r).toEqual({ ok: true, call: { name: 'complete_item', input: { item_id: 'i_abcdefghij', resolution: 'dropped' } } })
  })

  it('pads single-digit hours', () => {
    const r = parseToolCall('set_reminder', { item_id: 'i_abcdefghij', remind_date: '2026-10-22', remind_time: '8:30' })
    expect(r).toMatchObject({ ok: true, call: { input: { remind_time: '08:30' } } })
  })

  it('rejects bad ids, times, dates, extra keys and unknown tools', () => {
    expect(parseToolCall('set_reminder', { item_id: 'i_abcdefghij', remind_date: '2026-10-22', remind_time: '24:00' }).ok).toBe(false)
    expect(parseToolCall('complete_item', { item_id: 'milk', resolution: 'done' }).ok).toBe(false)
    expect(parseToolCall('set_reminder', { item_id: 'i_abcdefghij', remind_date: '2026-10-22', remind_time: '8pm' }).ok).toBe(false)
    expect(parseToolCall('set_reminder', { item_id: 'i_abcdefghij', remind_date: '2026-02-30', remind_time: '08:00' }).ok).toBe(false)
    expect(parseToolCall('add_note', { item_id: 'i_abcdefghij', text: 'x', extra: 1 }).ok).toBe(false)
    expect(parseToolCall('delete_item', { item_id: 'i_abcdefghij' })).toEqual({ ok: false, message: 'Unknown tool "delete_item".' })
  })
})
