// Invite links look like `${PUBLIC_URL}/join#token=<secret>`. The token lives in the fragment so
// link previews (WeChat fetches URLs) never send it to the server; joining is an explicit POST.

/** Invite secrets are base64url; anything after them (e.g. "?from=singlemessage" glued on by an app) is ignored. */
const TOKEN_CHARS = /^[A-Za-z0-9_\-.~]+/

/** Token from a location hash like "#token=abc". */
export function tokenFromHash(hash: string): string | null {
  const params = new URLSearchParams(hash.replace(/^#/, ''))
  const t = TOKEN_CHARS.exec(params.get('token')?.trim() ?? '')?.[0]
  return t ? t : null
}

/** Token from whatever the user pasted: the full invite link, "token=…", or the bare token. */
export function extractInviteToken(input: string): string | null {
  const s = input.trim()
  if (!s) return null
  const m = /[#?&]?token=([^&\s#]+)/.exec(s)
  if (m?.[1]) {
    try {
      return decodeURIComponent(m[1])
    } catch {
      return m[1]
    }
  }
  if (/^[A-Za-z0-9_\-.~]{16,}$/.test(s)) return s
  return null
}
