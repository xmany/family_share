// Text normalization for search and duplicate checks (SPEC §4: "duplicate checks and search compare
// Simplified-normalized text"). Titles and notes are stored as spoken; only comparisons are normalized.

import { Converter } from 'opencc-js/t2cn'

let t2s: ((text: string) => string) | null = null

/** Traditional → Simplified Chinese (OpenCC t → cn). Other scripts pass through unchanged. */
export function toSimplified(text: string): string {
  t2s ??= Converter({ from: 't', to: 'cn' })
  return t2s(text)
}

/** Full-width → half-width (NFKC), Traditional → Simplified, lower case, collapsed whitespace. */
export function normalizeForSearch(text: string): string {
  return toSimplified(text.normalize('NFKC')).toLowerCase().replace(/\s+/g, ' ').trim()
}
