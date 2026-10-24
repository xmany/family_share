import { describe, expect, it } from 'vitest'
import {
  APPLE_MIME_ORDER,
  DEFAULT_MIME_ORDER,
  extensionForMime,
  fileNameForMime,
  pickMimeType,
  resolveRecordedMime,
} from './recorder'

const supports =
  (...types: string[]) =>
  (t: string) =>
    types.includes(t)

describe('pickMimeType', () => {
  it('prefers audio/mp4 on Apple devices even when webm/opus is also supported', () => {
    expect(pickMimeType(supports('audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'), true)).toBe('audio/mp4')
  })

  it('prefers webm/opus elsewhere even when mp4 is also supported', () => {
    expect(pickMimeType(supports('audio/mp4', 'audio/webm', 'audio/webm;codecs=opus'), false)).toBe('audio/webm;codecs=opus')
  })

  it('falls back down the list', () => {
    // older Safari: only the AAC codec string
    expect(pickMimeType(supports('audio/mp4;codecs=mp4a.40.2'), true)).toBe('audio/mp4;codecs=mp4a.40.2')
    // Apple device that only has webm (unusual) still records
    expect(pickMimeType(supports('audio/webm'), true)).toBe('audio/webm')
    // Firefox: ogg/opus
    expect(pickMimeType(supports('audio/ogg;codecs=opus'), false)).toBe('audio/ogg;codecs=opus')
    // Chrome without the codec string
    expect(pickMimeType(supports('audio/webm', 'audio/mp4'), false)).toBe('audio/webm')
    // non-Apple browser that only does mp4 (e.g. some WebViews)
    expect(pickMimeType(supports('audio/mp4'), false)).toBe('audio/mp4')
  })

  it("returns '' when nothing is supported or the check is unavailable", () => {
    expect(pickMimeType(() => false, true)).toBe('')
    expect(pickMimeType(() => false, false)).toBe('')
    expect(pickMimeType(undefined, false)).toBe('')
    expect(pickMimeType(null, true)).toBe('')
  })

  it('treats a throwing isTypeSupported as unsupported and keeps going', () => {
    const flaky = (t: string) => {
      if (t.includes('codecs')) throw new Error('bad parameter')
      return t === 'audio/webm'
    }
    expect(pickMimeType(flaky, false)).toBe('audio/webm')
  })

  it('orders start with the platform-native container', () => {
    expect(APPLE_MIME_ORDER[0]).toBe('audio/mp4')
    expect(DEFAULT_MIME_ORDER[0]).toBe('audio/webm;codecs=opus')
  })
})

describe('extensionForMime / fileNameForMime', () => {
  it('maps mp4 audio to .m4a and webm to .webm (codec parameters ignored)', () => {
    expect(fileNameForMime('audio/mp4')).toBe('voice.m4a')
    expect(fileNameForMime('audio/mp4;codecs=mp4a.40.2')).toBe('voice.m4a')
    expect(fileNameForMime('audio/webm;codecs=opus')).toBe('voice.webm')
    expect(fileNameForMime('audio/webm')).toBe('voice.webm')
    expect(fileNameForMime('video/webm;codecs=opus')).toBe('voice.webm')
  })

  it('handles the other containers and unknowns', () => {
    expect(extensionForMime('audio/ogg;codecs=opus')).toBe('ogg')
    expect(extensionForMime('audio/aac')).toBe('aac')
    expect(extensionForMime('audio/wav')).toBe('wav')
    expect(extensionForMime('audio/mpeg')).toBe('mp3')
    expect(extensionForMime('AUDIO/MP4')).toBe('m4a')
    expect(extensionForMime('')).toBe('bin')
    expect(extensionForMime('application/octet-stream')).toBe('bin')
  })
})

describe('resolveRecordedMime', () => {
  it("uses the recorder's actual type first", () => {
    expect(resolveRecordedMime('audio/mp4', 'audio/webm', 'audio/webm', false)).toBe('audio/mp4')
  })
  it('falls back to the blob type, then the chosen type, then the platform default', () => {
    expect(resolveRecordedMime('', 'audio/webm;codecs=opus', '', false)).toBe('audio/webm;codecs=opus')
    expect(resolveRecordedMime('', '', 'audio/mp4', true)).toBe('audio/mp4')
    expect(resolveRecordedMime('', '', '', true)).toBe('audio/mp4')
    expect(resolveRecordedMime('', '', '', false)).toBe('audio/webm')
  })
})
