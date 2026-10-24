#!/usr/bin/env node
// Generates the PWA icons in src/web/public/icons/ with no dependencies (PNG encoded with node:zlib).
// The mark is a soft rounded house with a heart cut out of it, on the app's accent color.
//
//   node scripts/make-icons.mjs
//
// Outputs:
//   icon-192.png, icon-512.png   rounded-square app icon (purpose "any")
//   icon-maskable-512.png        full-bleed, mark inside the 80% safe zone (purpose "maskable")
//   apple-touch-icon.png         180x180, opaque (iOS adds its own rounded mask)
//   badge-96.png                 monochrome white on transparent (Android status-bar badge)

import { deflateSync } from 'node:zlib'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'web', 'public', 'icons')

// Accent (matches --color-accent in src/web/index.css), with a slightly lighter top for depth.
const ACCENT_TOP = [0xd8, 0x79, 0x4d]
const ACCENT_BOTTOM = [0xbd, 0x5b, 0x33]
const WHITE = [0xff, 0xff, 0xff]

// ---------- PNG encoding

const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()

function crc32(buf) {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(td))
  return Buffer.concat([len, td, crc])
}

/** rgba: Uint8Array of w*h*4. alpha=false writes an opaque RGB PNG. */
function encodePng(w, h, rgba, { alpha = true } = {}) {
  const channels = alpha ? 4 : 3
  const raw = Buffer.alloc((w * channels + 1) * h)
  for (let y = 0; y < h; y++) {
    const row = y * (w * channels + 1)
    raw[row] = 0 // filter: none
    for (let x = 0; x < w; x++) {
      const s = (y * w + x) * 4
      const d = row + 1 + x * channels
      raw[d] = rgba[s]
      raw[d + 1] = rgba[s + 1]
      raw[d + 2] = rgba[s + 2]
      if (alpha) raw[d + 3] = rgba[s + 3]
    }
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0)
  ihdr.writeUInt32BE(h, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = alpha ? 6 : 2 // RGBA / RGB
  ihdr[10] = 0
  ihdr[11] = 0
  ihdr[12] = 0
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

// ---------- shapes (signed distance functions; negative = inside). Coordinates in [0,1], y down.

function sdRoundedRect(x, y, half, r) {
  // square centered at 0.5 with half-size `half` and corner radius r
  const qx = Math.abs(x - 0.5) - half + r
  const qy = Math.abs(y - 0.5) - half + r
  const ox = Math.max(qx, 0)
  const oy = Math.max(qy, 0)
  return Math.hypot(ox, oy) + Math.min(Math.max(qx, qy), 0) - r
}

// iq's exact polygon SDF
function sdPolygon(px, py, v) {
  let d = (px - v[0][0]) ** 2 + (py - v[0][1]) ** 2
  let s = 1
  for (let i = 0, j = v.length - 1; i < v.length; j = i, i++) {
    const ex = v[j][0] - v[i][0]
    const ey = v[j][1] - v[i][1]
    const wx = px - v[i][0]
    const wy = py - v[i][1]
    const t = Math.min(Math.max((wx * ex + wy * ey) / (ex * ex + ey * ey), 0), 1)
    const bx = wx - ex * t
    const by = wy - ey * t
    d = Math.min(d, bx * bx + by * by)
    const c1 = py >= v[i][1]
    const c2 = py < v[j][1]
    const c3 = ex * wy > ey * wx
    if ((c1 && c2 && c3) || (!c1 && !c2 && !c3)) s = -s
  }
  return s * Math.sqrt(d)
}

// iq's heart SDF: tip at (0,0), lobes up to y≈1.1, y up.
function sdHeart(x, y) {
  x = Math.abs(x)
  if (y + x > 1) return Math.hypot(x - 0.25, y - 0.75) - Math.SQRT2 / 4
  const a = x * x + (y - 1) ** 2
  const m = 0.5 * Math.max(x + y, 0)
  const b = (x - m) ** 2 + (y - m) ** 2
  return Math.sqrt(Math.min(a, b)) * Math.sign(x - y)
}

const HOUSE_ROUND = 0.07
// Pentagon house, inset by the rounding radius so the rounded shape keeps its size.
const HOUSE = [
  [0.5, 0.14 + HOUSE_ROUND * 1.2],
  [0.88 - HOUSE_ROUND, 0.46],
  [0.88 - HOUSE_ROUND, 0.86 - HOUSE_ROUND],
  [0.12 + HOUSE_ROUND, 0.86 - HOUSE_ROUND],
  [0.12 + HOUSE_ROUND, 0.46],
]
const HEART_SCALE = 0.27
const HEART_TIP_Y = 0.775

function inHouse(mx, my) {
  return sdPolygon(mx, my, HOUSE) - HOUSE_ROUND <= 0
}
function inHeart(mx, my) {
  return sdHeart((mx - 0.5) / HEART_SCALE, (HEART_TIP_Y - my) / HEART_SCALE) <= 0
}

/**
 * bg: 'rounded' | 'full' | 'none'
 * markScale: size of the mark box relative to the icon
 * heart: 'bg' (heart shows the background) | 'clear' (heart is transparent)
 */
function render(size, { bg, markScale, heart }) {
  const SS = 5 // supersampling per axis
  const out = new Uint8Array(size * size * 4)
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let r = 0
      let g = 0
      let b = 0
      let a = 0
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const u = (px + (sx + 0.5) / SS) / size
          const v = (py + (sy + 0.5) / SS) / size
          let color = null
          const bgColor = [
            ACCENT_TOP[0] + (ACCENT_BOTTOM[0] - ACCENT_TOP[0]) * v,
            ACCENT_TOP[1] + (ACCENT_BOTTOM[1] - ACCENT_TOP[1]) * v,
            ACCENT_TOP[2] + (ACCENT_BOTTOM[2] - ACCENT_TOP[2]) * v,
          ]
          if (bg === 'full') color = bgColor
          else if (bg === 'rounded' && sdRoundedRect(u, v, 0.5, 0.225) <= 0) color = bgColor
          const mx = (u - 0.5) / markScale + 0.5
          const my = (v - 0.5) / markScale + 0.5
          if (inHouse(mx, my)) {
            if (!inHeart(mx, my)) color = WHITE
            else if (heart === 'clear') color = null
          }
          if (color) {
            r += color[0]
            g += color[1]
            b += color[2]
            a += 1
          }
        }
      }
      const i = (py * size + px) * 4
      const n = SS * SS
      if (a > 0) {
        out[i] = Math.round(r / a)
        out[i + 1] = Math.round(g / a)
        out[i + 2] = Math.round(b / a)
      }
      out[i + 3] = Math.round((a / n) * 255)
    }
  }
  return out
}

function write(name, size, opts, pngOpts) {
  const png = encodePng(size, size, render(size, opts), pngOpts)
  writeFileSync(join(OUT_DIR, name), png)
  console.log(`${name.padEnd(24)} ${size}x${size}  ${png.length} bytes`)
}

mkdirSync(OUT_DIR, { recursive: true })
write('icon-192.png', 192, { bg: 'rounded', markScale: 0.74, heart: 'bg' })
write('icon-512.png', 512, { bg: 'rounded', markScale: 0.74, heart: 'bg' })
write('icon-maskable-512.png', 512, { bg: 'full', markScale: 0.6, heart: 'bg' })
write('apple-touch-icon.png', 180, { bg: 'full', markScale: 0.7, heart: 'bg' }, { alpha: false })
write('badge-96.png', 96, { bg: 'none', markScale: 0.96, heart: 'clear' })
