// 加入 (/join#token=…) and the signed-out screen. Joining is an explicit POST so WeChat's link
// previews (GET) never use up an invite. After joining: go to / with the install + notification
// onboarding card.

import { useEffect, useRef, useState } from 'react'
import { api, errorMessage, isApiError } from '../lib/api'
import { extractInviteToken, tokenFromHash } from '../lib/invite'
import { isIOS, isStandalone, isWeChat } from '../lib/platform'
import { navigate } from '../lib/router'
import { bootstrap } from '../lib/store'
import { copyText, toast } from '../lib/toast'
import { LogoMark } from '../components/Logo'
import { Spinner } from '../components/ui'
import { markJustJoined } from './ChatPage'

async function joinWith(token: string) {
  await api.join(token)
  markJustJoined()
  await bootstrap()
  navigate('/', { replace: true })
}

function joinErrorMessage(e: unknown): string {
  if (isApiError(e) && (e.status === 401 || e.status === 404 || e.status === 410 || e.status === 400))
    return '这个邀请链接无效或已过期。请让家人在「设置 → 家人」里重新生成一个。'
  return errorMessage(e, '加入失败了，请稍后再试')
}

/** Removes the invite secret from the address bar and the history entry. */
function forgetTokenInUrl() {
  navigate('/join', { replace: true })
}

export function JoinPage() {
  const [state, setState] = useState<'joining' | 'missing' | 'error' | 'wechat'>('joining')
  const [error, setError] = useState('')
  const started = useRef(false)
  const tokenRef = useRef<string | null>(null)

  const join = (token: string) => {
    // keep the secret out of the address bar and history
    forgetTokenInUrl()
    setState('joining')
    joinWith(token).catch(e => {
      setError(joinErrorMessage(e))
      setState('error')
    })
  }

  useEffect(() => {
    if (started.current) return
    started.current = true
    const token = tokenFromHash(window.location.hash)
    if (!token) {
      setState('missing')
      return
    }
    tokenRef.current = token
    // In WeChat the person has to continue in a real browser (install + notifications), and
    // ··· → 在浏览器打开 opens the CURRENT address: keep the token in it until they decide.
    if (isWeChat()) {
      setState('wechat')
      return
    }
    join(token)
  }, [])

  if (state === 'wechat') {
    return (
      <WeChatJoin
        onCopy={async () => {
          const ok = await copyText(window.location.href)
          toast(ok ? '链接已复制，粘贴到 Safari 或 Chrome 的地址栏打开' : '复制失败，请回到聊天里长按链接复制', ok ? 'ok' : 'danger')
        }}
        onJoinHere={() => tokenRef.current && join(tokenRef.current)}
      />
    )
  }

  if (state === 'joining') {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-4 px-6 py-24 text-center">
        <LogoMark size={64} />
        <Spinner />
        <p className="text-muted">正在加入家庭…</p>
      </div>
    )
  }
  return <SignedOut message={state === 'missing' ? '邀请链接不完整。请把家人发给你的整条链接粘贴到下面。' : error} />
}

/** Invite opened inside WeChat: continue in the phone's browser (the token stays in the URL for that). */
function WeChatJoin({ onCopy, onJoinHere }: { onCopy: () => void; onJoinHere: () => void }) {
  const ios = isIOS()
  return (
    <div className="mx-auto flex w-full max-w-md flex-1 flex-col gap-5 px-5 py-10">
      <div className="flex flex-col items-center gap-3 text-center">
        <LogoMark size={72} />
        <h1 className="text-[22px] font-bold">请在{ios ? ' Safari ' : '浏览器'}里打开这个邀请</h1>
        <p className="text-[15px] text-muted">在微信里没法把「家庭同步」装到手机上，也收不到提醒。</p>
      </div>
      <ol className="card flex flex-col gap-2.5 p-4 text-[16px]">
        <li>1. 点右上角的 ···</li>
        <li>2. 选「{ios ? '在 Safari 中打开' : '在浏览器打开'}」</li>
        <li>3. 在打开的页面里会自动加入家庭</li>
      </ol>
      {!ios && (
        <p className="text-[14px] text-muted">
          如果打开的不是 Chrome：点下面的按钮复制链接，再粘贴到 Chrome 的地址栏里打开。
        </p>
      )}
      <div className="flex flex-col gap-2">
        <button type="button" className="btn btn-primary btn-lg" onClick={onCopy}>
          复制邀请链接
        </button>
        <button type="button" className="btn btn-ghost" onClick={onJoinHere}>
          先在微信里看看
        </button>
      </div>
    </div>
  )
}

/** Shown on /join failures and whenever the session is missing (401). */
export function SignedOut({ message }: { message?: string }) {
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const iosApp = isIOS() && isStandalone()

  const submit = async () => {
    const token = extractInviteToken(text)
    if (!token) {
      setError('没认出邀请链接，请粘贴完整的链接')
      return
    }
    setBusy(true)
    setError(null)
    try {
      await joinWith(token)
    } catch (e) {
      setError(joinErrorMessage(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="mx-auto flex w-full max-w-md flex-1 flex-col gap-5 px-5 py-12">
      <div className="flex flex-col items-center gap-3 text-center">
        <LogoMark size={72} />
        <h1 className="text-[22px] font-bold">请用家人发给你的邀请链接加入</h1>
        <p className="text-[15px] text-muted">家里已经在用的人可以在「设置 → 家人 → 邀请家人」生成链接，然后在这台手机上打开。</p>
      </div>
      {message && <p className="rounded-xl bg-danger-soft px-3 py-2.5 text-[15px] text-danger">{message}</p>}
      {iosApp && (
        <p className="rounded-xl bg-info-soft px-3 py-2.5 text-[15px] text-info">
          从主屏幕打开的「家庭同步」和 Safari 是分开登录的。把邀请链接粘贴到下面，就能在这里登录。
        </p>
      )}
      <form
        className="card flex flex-col gap-3 p-4"
        onSubmit={e => {
          e.preventDefault()
          void submit()
        }}
      >
        <label className="label" htmlFor="invite-link">
          粘贴邀请链接
        </label>
        <input
          id="invite-link"
          className="input"
          inputMode="url"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          placeholder="https://…/join#token=…"
          value={text}
          onChange={e => setText(e.target.value)}
        />
        {error && <p className="text-[14px] text-danger">{error}</p>}
        <button type="submit" className="btn btn-primary btn-lg" disabled={busy || !text.trim()}>
          {busy ? '正在加入…' : '加入'}
        </button>
      </form>
    </div>
  )
}
