// The app mark (same drawing as the PNG icons from scripts/make-icons.mjs).

import { useId } from 'react'

export function LogoMark({ size = 48 }: { size?: number }) {
  const id = `fslogo${useId().replace(/[^a-zA-Z0-9]/g, '')}`
  return (
    <svg width={size} height={size} viewBox="0 0 100 100" aria-hidden="true" focusable="false">
      <defs>
        <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#d8794d" />
          <stop offset="1" stopColor="#bd5b33" />
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
      <path d="M50 70.4 L60 60.4 A7.07 7.07 0 0 0 50 50.4 A7.07 7.07 0 0 0 40 60.4 Z" fill={`url(#${id})`} />
    </svg>
  )
}
