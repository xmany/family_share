import { describe, expect, it } from 'vitest'
import { matchRoute, stripPushMarker } from './router'
import { extractInviteToken, tokenFromHash } from './invite'
import { avatarText } from './labels'

describe('matchRoute', () => {
  it('maps every app path', () => {
    expect(matchRoute('/')).toEqual({ name: 'chat' })
    expect(matchRoute('/index.html')).toEqual({ name: 'chat' })
    expect(matchRoute('/board')).toEqual({ name: 'board' })
    expect(matchRoute('/weekly')).toEqual({ name: 'weekly' })
    expect(matchRoute('/settings')).toEqual({ name: 'settings' })
    expect(matchRoute('/join')).toEqual({ name: 'join' })
    expect(matchRoute('/item/i_abc123')).toEqual({ name: 'item', id: 'i_abc123' })
    expect(matchRoute('/t/eyJpIjoiaV8xIn0.sig-_x')).toEqual({ name: 'link', token: 'eyJpIjoiaV8xIn0.sig-_x' })
  })

  it('tolerates trailing and doubled slashes and decodes ids', () => {
    expect(matchRoute('/board/')).toEqual({ name: 'board' })
    expect(matchRoute('//settings')).toEqual({ name: 'settings' })
    expect(matchRoute('/item/i%5F1/')).toEqual({ name: 'item', id: 'i_1' })
    expect(matchRoute('/item/%E0%A4%A')).toEqual({ name: 'item', id: '%E0%A4%A' }) // malformed escape kept as-is
  })

  it('returns not_found for unknown paths', () => {
    expect(matchRoute('/nope')).toEqual({ name: 'not_found' })
    expect(matchRoute('/item')).toEqual({ name: 'not_found' })
    expect(matchRoute('/item/a/b')).toEqual({ name: 'not_found' })
    expect(matchRoute('/t/')).toEqual({ name: 'not_found' })
  })
})

describe('stripPushMarker', () => {
  it('removes src=push and keeps other parameters (WeChat adds ?from=…)', () => {
    expect(stripPushMarker('?src=push')).toBe('')
    expect(stripPushMarker('?from=singlemessage&src=push')).toBe('?from=singlemessage')
    expect(stripPushMarker('?from=singlemessage&isappinstalled=0')).toBe('?from=singlemessage&isappinstalled=0')
    expect(stripPushMarker('?src=other')).toBe('?src=other')
    expect(stripPushMarker('')).toBe('')
  })
})

describe('invite tokens', () => {
  it('reads #token= from the hash', () => {
    expect(tokenFromHash('#token=abc_DEF-123')).toBe('abc_DEF-123')
    expect(tokenFromHash('#token=')).toBeNull()
    expect(tokenFromHash('')).toBeNull()
    expect(tokenFromHash('#other=1&token=xyz')).toBe('xyz')
    // something appended to the fragment (e.g. by an in-app browser) is not part of the token
    expect(tokenFromHash('#token=abc_DEF-123?from=singlemessage')).toBe('abc_DEF-123')
  })

  it('extracts a token from a pasted link or a bare token', () => {
    expect(extractInviteToken('https://family.example.com/join#token=Zm9vYmFyYmF6cXV4MTIz')).toBe('Zm9vYmFyYmF6cXV4MTIz')
    expect(extractInviteToken('  打开 https://x.test/join#token=abc123&x=1 加入 ')).toBe('abc123')
    expect(extractInviteToken('Zm9vYmFyYmF6cXV4MTIzNDU2')).toBe('Zm9vYmFyYmF6cXV4MTIzNDU2')
    expect(extractInviteToken('hello')).toBeNull()
    expect(extractInviteToken('')).toBeNull()
  })
})

describe('avatarText', () => {
  it('keeps Chinese family names distinguishable', () => {
    expect(avatarText('老公')).toBe('老公')
    expect(avatarText('老婆')).toBe('老婆')
    expect(avatarText('外婆')).toBe('外婆')
    expect(avatarText('王小明')).toBe('小明')
    expect(avatarText('妈')).toBe('妈')
    expect(avatarText(' emma ')).toBe('E')
    expect(avatarText('')).toBe('?')
  })
})
