// Small shared building blocks.

import type { ReactNode } from 'react'
import type { Member } from '../../shared/types'
import { avatarText, type Tone } from '../lib/labels'
import { goBack } from '../lib/router'
import { useToast } from '../lib/toast'
import { isWeChat } from '../lib/platform'
import { IconAlert, IconBack } from './Icons'

export function Avatar({ member, size = 32, title }: { member: Member | null | undefined; size?: number; title?: string }) {
  const name = member?.name ?? '?'
  const text = avatarText(name)
  const len = Array.from(text).length
  return (
    <span
      className="avatar"
      title={title ?? name}
      aria-hidden={title ? undefined : true}
      style={{
        width: size,
        height: size,
        fontSize: Math.round(size * (len > 1 ? 0.36 : 0.46)),
        letterSpacing: len > 1 ? '-0.02em' : undefined,
        background: member?.color ?? 'var(--color-faint)',
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
    <header className="page-header">
      {back && (
        <button type="button" className="icon-btn -ml-1" aria-label="返回" onClick={() => goBack(back)}>
          <IconBack size={26} />
        </button>
      )}
      <h1 className={back ? 'flex-1 truncate text-[18px] font-semibold' : 'page-title flex-1 truncate'}>{title}</h1>
      {right}
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
  return <p className="px-1 py-2 text-[15px] text-muted">{children}</p>
}

export function LoadingScreen({ label = '加载中…' }: { label?: string }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 py-24 text-muted">
      <Spinner />
      <span className="text-sm">{label}</span>
    </div>
  )
}

export function ErrorNote({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="card mx-4 mt-6 flex flex-col items-start gap-3 p-4">
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
