// Production static serving of dist/web with SPA fallback (SPEC §5):
// - index.html, sw.js, the manifest and registerSW.js: Cache-Control no-cache (always revalidated)
// - /assets/* (content-hashed by Vite): immutable for a year; a missing asset is a 404, never index.html
// - any other path without a file: index.html (path routes /board, /item/:id, /t/:token …)

import { existsSync, statSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { extname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
}

const NO_CACHE_FILES = new Set(['/index.html', '/sw.js', '/manifest.webmanifest', '/manifest.json', '/registerSW.js'])
const IMMUTABLE = 'public, max-age=31536000, immutable'
const SHORT = 'public, max-age=3600'

/** dist/web next to the working directory, or next to the bundled server (dist/server/index.js → dist/web). */
export function defaultWebDir(): string | null {
  const candidates = [resolve(process.cwd(), 'dist/web')]
  try {
    candidates.push(fileURLToPath(new URL('../web', import.meta.url)))
  } catch {
    // import.meta.url not a file URL (bundled differently): ignore
  }
  return candidates.find(d => existsSync(join(d, 'index.html'))) ?? null
}

function cacheControlFor(urlPath: string): string {
  if (NO_CACHE_FILES.has(urlPath) || urlPath.endsWith('.html')) return 'no-cache'
  if (urlPath.startsWith('/assets/')) return IMMUTABLE
  // workbox runtime chunks are content-hashed too
  if (/^\/workbox-[0-9a-f]{6,}\.js$/.test(urlPath)) return IMMUTABLE
  return SHORT
}

function fileResponse(body: Buffer, filePath: string, urlPath: string, method: string): Response {
  const headers = new Headers({
    'Content-Type': CONTENT_TYPES[extname(filePath).toLowerCase()] ?? 'application/octet-stream',
    'Content-Length': String(body.length),
    'Cache-Control': cacheControlFor(urlPath),
  })
  return new Response(method === 'HEAD' ? null : new Uint8Array(body), { status: 200, headers })
}

/**
 * Returns a function answering a GET/HEAD for a non-API path from webDir, or null when the path should
 * 404 (a missing hashed asset). The caller has already excluded /api, /wechat and /healthz.
 */
export function createStaticServer(webDir: string) {
  const root = resolve(webDir)
  const indexPath = join(root, 'index.html')

  function resolveFile(urlPath: string): string | null {
    let decoded: string
    try {
      decoded = decodeURIComponent(urlPath)
    } catch {
      return null
    }
    if (decoded.includes('\0')) return null
    const full = resolve(root, '.' + decoded)
    if (full !== root && !full.startsWith(root + sep)) return null // path traversal
    try {
      return statSync(full).isFile() ? full : null
    } catch {
      return null
    }
  }

  return async function serve(urlPath: string, method: string): Promise<Response | null> {
    const file = urlPath === '/' ? null : resolveFile(urlPath)
    if (file) return fileResponse(await readFile(file), file, urlPath, method)
    if (urlPath.startsWith('/assets/') || urlPath.startsWith('/icons/')) return null
    if (!existsSync(indexPath)) return null
    return fileResponse(await readFile(indexPath), indexPath, '/index.html', method)
  }
}
