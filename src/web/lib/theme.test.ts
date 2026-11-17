import { describe, expect, it } from 'vitest'
import { parseThemePref, resolveTheme } from './theme'

describe('theme preference', () => {
  it('follows the phone unless light or dark was chosen', () => {
    expect(parseThemePref(null)).toBe('system')
    expect(parseThemePref('')).toBe('system')
    expect(parseThemePref('auto')).toBe('system')
    expect(parseThemePref('light')).toBe('light')
    expect(parseThemePref('dark')).toBe('dark')
  })

  it('resolves "follow the phone" from the system setting, and a choice regardless of it', () => {
    expect(resolveTheme('system', true)).toBe('dark')
    expect(resolveTheme('system', false)).toBe('light')
    expect(resolveTheme('light', true)).toBe('light')
    expect(resolveTheme('dark', false)).toBe('dark')
  })
})
