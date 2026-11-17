// Small shared building blocks.

import type { ReactNode } from 'react'
import type { Member } from '../../shared/types'
import { avatarText, type Tone } from '../lib/labels'
import { goBack } from '../lib/router'
import { useToast } from '../lib/toast'
import { isWeChat } from '../lib/platform'
import { IconAlert, IconBack } from './Icons'
import { LogoMark } from './Logo'

/**
 * The server hands members colours from its palette (MEMBER_PALETTE in server/domain/domain.ts); each one picks a soft
 * tone of the design system here, so avatars stay legible in light and dark. A colour set by hand keeps its own fill.
 */
const AVATAR_TONES: Record<string, string> = {
  '#3b82f6': 'blue',
  '#ec4899': 'pink',
  '#10b981': 'green',
  '#f59e0b': 'amber',
  '#8b5cf6': 'violet',
  '#06b6d4': 'teal',
  '#ef4444': 'red',
  '#84cc16': 'lime',
}

export function Avatar({ member, size = 32, title }: { member: Member | null | undefined; size?: number; title?: string }) {
  const name = member?.name ?? '?'
  const text = avatarText(name)
  const len = Array.from(text).length
  const color = member?.color?.trim().toLowerCase()
  const tone = color ? AVATAR_TONES[color] : undefined
  return (
    <span
      className={`avatar${tone ? ` av-${tone}` : ''}`}
      title={title ?? name}
      aria-hidden={title ? undefined : true}
      style={{
        width: size,
        height: size,
        fontSize: Math.round(size * (len > 1 ? 0.36 : 0.46)),
        letterSpacing: len > 1 ? '-0.02em' : undefined,
        ...(color && !tone ? { background: color, color: '#fff', boxShadow: 'none' } : {}),
      }}
    >
      {text}
    </span>
  )
}

export function Pill({ tone = 'neutral', children }: { tone?: Tone; children: ReactNode }) {
  return <span className={`pill${tone === 'neutral' ? '' : ` tone-${tone}`}`}>{children}</span>
}

export function Spinner({ className = '' }: { className?: string }) {
  return <span className={`spinner inline-block ${className}`} role="status" aria-label="加载中" />
}

/** The app bar: the mark and the page's name on top-level pages, a back button on the pages below them. */
export function PageHeader({
  title,
  back,
  right,
}: {
  title: ReactNode
  /** fallback path when there is no in-app history to go back to */
  back?: string
  right?: ReactNode
}) {
  return (
    <header className="appbar">
      {back ? (
        <button type="button" className="icon-btn -ml-1" aria-label="返回" onClick={() => goBack(back)}>
          <IconBack size={20} />
        </button>
      ) : (
        <LogoMark size={28} />
      )}
      <h1 className="appbar-title">{title}</h1>
      {right && <div className="appbar-actions">{right}</div>}
    </header>
  )
}

export function Section({
  title,
  count,
  hint,
  children,
}: {
  title: string
  count?: number
  hint?: string
  children: ReactNode
}) {
  return (
    <section>
      <h2 className="section-title">
        <span>{title}</span>
        {count !== undefined && count > 0 && <span className="count">{count}</span>}
        {hint && <span className="section-hint">{hint}</span>}
      </h2>
      {children}
    </section>
  )
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="empty">{children}</p>
}

export function LoadingScreen({ label = '加载中…' }: { label?: string }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 py-24 text-muted">
      <Spinner />
      <span className="text-[14px]">{label}</span>
    </div>
  )
}

export function ErrorNote({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="card mx-4 mt-6 flex flex-col items-start gap-3 p-5">
      <div className="flex items-start gap-2 text-danger">
        <IconAlert size={20} className="mt-0.5 flex-none" />
        <span>{message}</span>
      </div>
      {onRetry && (
        <button type="button" className="btn btn-sm" onClick={onRetry}>
          重试
        </button>
      )}
    </div>
  )
}

/** Shown on every screen inside WeChat's in-app browser (no install, no push there). */
export function WeChatBanner() {
  if (!isWeChat()) return null
  return (
    <div className="banner" role="note">
      <IconAlert size={18} className="mt-0.5 flex-none" />
      <span>点右上角 ··· → 在浏览器打开，以安装/开启通知</span>
    </div>
  )
}

export function Toaster() {
  const t = useToast()
  if (!t) return null
  return (
    <div key={t.id} className="toast" data-tone={t.tone} role="status" aria-live="polite">
      {t.text}
    </div>
  )
}
