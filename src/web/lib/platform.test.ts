import { describe, expect, it } from 'vitest'
import {
  isAndroidFromUA,
  isAppleFromUA,
  isIOSFromUA,
  isMacSafariFromUA,
  isWeChatFromUA,
  sameBytes,
  urlBase64ToUint8Array,
} from './platform'

const UA = {
  iphoneSafari:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Mobile/15E148 Safari/604.1',
  iphoneWeChat:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 MicroMessenger/8.0.60(0x18003c2f) NetType/WIFI Language/zh_CN',
  iphoneChrome:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/140.0.0.0 Mobile/15E148 Safari/604.1',
  ipadDesktop:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Safari/605.1.15',
  macChrome:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
  androidChrome:
    'Mozilla/5.0 (Linux; Android 15; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36',
  androidWeChat:
    'Mozilla/5.0 (Linux; Android 14; 23127PN0CC Build/UKQ1.230804.001; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/130.0.6723.103 Mobile Safari/537.36 XWEB/1300333 MMWEBSDK/20240802 MicroMessenger/8.0.51.2720(0x28003336) WeChat/arm64 Weixin NetType/WIFI Language/zh_CN ABI/arm64',
}

describe('device detection', () => {
  it('detects iOS, including iPadOS with a desktop user agent', () => {
    expect(isIOSFromUA(UA.iphoneSafari)).toBe(true)
    expect(isIOSFromUA(UA.iphoneWeChat)).toBe(true)
    expect(isIOSFromUA(UA.iphoneChrome)).toBe(true)
    expect(isIOSFromUA(UA.ipadDesktop, 'MacIntel', 5)).toBe(true)
    expect(isIOSFromUA(UA.ipadDesktop, 'MacIntel', 0)).toBe(false) // a real Mac
    expect(isIOSFromUA(UA.androidChrome)).toBe(false)
    // desktop devtools emulating an Android phone on a Mac (platform MacIntel + touch points)
    expect(isIOSFromUA(UA.androidChrome, 'MacIntel', 5)).toBe(false)
  })

  it('detects Android', () => {
    expect(isAndroidFromUA(UA.androidChrome)).toBe(true)
    expect(isAndroidFromUA(UA.androidWeChat)).toBe(true)
    expect(isAndroidFromUA(UA.iphoneSafari)).toBe(false)
  })

  it("detects WeChat's in-app browser on both platforms", () => {
    expect(isWeChatFromUA(UA.iphoneWeChat)).toBe(true)
    expect(isWeChatFromUA(UA.androidWeChat)).toBe(true)
    expect(isWeChatFromUA(UA.iphoneSafari)).toBe(false)
    expect(isWeChatFromUA(UA.androidChrome)).toBe(false)
  })

  it('treats every iOS browser and Mac Safari as Apple, but not Chrome on a Mac', () => {
    expect(isAppleFromUA(UA.iphoneChrome)).toBe(true)
    expect(isAppleFromUA(UA.iphoneWeChat)).toBe(true)
    expect(isMacSafariFromUA(UA.ipadDesktop)).toBe(true)
    expect(isAppleFromUA(UA.ipadDesktop, 'MacIntel', 0)).toBe(true)
    expect(isAppleFromUA(UA.macChrome, 'MacIntel', 0)).toBe(false)
    expect(isAppleFromUA(UA.androidChrome)).toBe(false)
  })
})

describe('urlBase64ToUint8Array', () => {
  it('decodes URL-safe base64 without padding', () => {
    // bytes 0xfb 0xff 0xbf → standard "+/+/" style chars become "-_"
    expect([...urlBase64ToUint8Array('-_-_')]).toEqual([0xfb, 0xff, 0xbf])
    expect([...urlBase64ToUint8Array('AQID')]).toEqual([1, 2, 3])
    expect([...urlBase64ToUint8Array('AQ')]).toEqual([1])
  })

  it('decodes a 65-byte VAPID public key', () => {
    const key = 'BEl62iUYgUivxIkv69yViEuiBIa-Ib9-SkvMeAtA3LFgDzkrxZJjSgSnfckjBJuBkr3qBUYIHBQFLXYp5Nksh8U'
    const bytes = urlBase64ToUint8Array(key)
    expect(bytes.length).toBe(65)
    expect(bytes[0]).toBe(0x04) // uncompressed P-256 point
  })
})

describe('sameBytes', () => {
  it('compares buffers and views', () => {
    const a = new Uint8Array([1, 2, 3])
    expect(sameBytes(a.buffer, new Uint8Array([1, 2, 3]))).toBe(true)
    expect(sameBytes(a, new Uint8Array([1, 2, 3]))).toBe(true)
    expect(sameBytes(a, new Uint8Array([1, 2, 4]))).toBe(false)
    expect(sameBytes(a, new Uint8Array([1, 2]))).toBe(false)
    expect(sameBytes(null, new Uint8Array([1]))).toBe(false)
  })
})
