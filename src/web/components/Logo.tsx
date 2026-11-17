// The app mark (same drawing as the PNG icons from scripts/make-icons.mjs): a white house on hulicalendar's icon navy,
// with a fox-orange heart.

import { useId } from 'react'

export const MARK_NAVY_TOP = '#22385f'
export const MARK_NAVY_BOTTOM = '#182845'
export const MARK_HEART = '#fb6309'

export function LogoMark({ size = 48 }: { size?: number }) {
  const id = `fslogo${useId().replace(/[^a-zA-Z0-9]/g, '')}`
  return (
    <svg width={size} height={size} viewBox="0 0 100 100" aria-hidden="true" focusable="false" className="flex-none">
      <defs>
        <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor={MARK_NAVY_TOP} />
          <stop offset="1" stopColor={MARK_NAVY_BOTTOM} />
        </linearGradient>
      </defs>
      <rect width="100" height="100" rx="23" fill={`url(#${id})`} />
      <path
        d="M50 27 L74.5 48 L74.5 73 L25.5 73 L25.5 48 Z"
        fill="#fff"
        stroke="#fff"
        strokeWidth="8"
        strokeLinejoin="round"
      />
      <path d="M50 70.4 L60 60.4 A7.07 7.07 0 0 0 50 50.4 A7.07 7.07 0 0 0 40 60.4 Z" fill={MARK_HEART} />
    </svg>
  )
}
