// /t/:token — signed item link from WeChat messages. Works without a session (WeChat's in-app
// browser has none): GET/POST /api/t/:token, big buttons for the actions the token allows.

import { useCallback, useEffect, useState } from 'react'
import type { LinkViewResponse } from '../../shared/api'
import type { Member } from '../../shared/types'
import { describeRepeat } from '../../shared/repeat'
import { api, errorMessage, isApiError } from '../lib/api'
import { dueInfo, isActive } from '../lib/board'
import { KIND_LABEL } from '../lib/labels'
import { Link } from '../lib/router'
import { isWeChat } from '../lib/platform'
import { KindIcon, RespondControl, StatusPill } from '../components/items'
import { IconCheck, IconClock } from '../components/Icons'
import { LogoMark } from '../components/Logo'
import { LoadingScreen } from '../components/ui'

function who(id: string | null, members: Member[], viewerId: string): string {
  if (!id) return '没人'
  if (id === viewerId) return '你'
  return members.find(m => m.id === id)?.name ?? '家人'
}

export function LinkPage({ token }: { token: string }) {
  const [data, setData] = useState<LinkViewResponse | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [doneHere, setDoneHere] = useState(false)

  const load = useCallback(async () => {
    try {
      setData(await api.linkView(token))
      setError(null)
    } catch (e) {
      setError(
        isApiError(e) && [401, 403, 404, 410].includes(e.status)
          ? '这个链接已经失效了（链接 72 小时内有效）。打开「家庭同步」App 就能看到最新情况。'
          : errorMessage(e),
      )
    }
  }, [token])

  useEffect(() => {
    void load()
  }, [load])

  const act = async (action: 'accept' | 'decline' | 'done', note?: string) => {
    const r = await api.linkAction(token, note ? { action, message: note } : { action })
    setData(r)
    const next = r.item.repeat ? dueInfo(r.item, new Date(), r.family.timezone) : null
    setMessage(
      action === 'accept'
        ? '已接受，已经告诉对方了'
        : action === 'decline'
          ? '已告诉对方你做不了'
          : next
            ? `这次完成了，下次 ${next.label}`
            : '完成了，辛苦啦',
    )
    if (action === 'done') setDoneHere(true)
  }

  const header = (
    <div className="flex items-center gap-3 px-5 pt-6 pb-2">
      <LogoMark size={36} />
      <div>
        <p className="text-[17px] leading-tight font-[620]">家庭同步</p>
        {data && <p className="hint">{data.family.name}</p>}
      </div>
    </div>
  )

  if (!data) {
    return (
      <div className="mx-auto flex w-full max-w-md flex-1 flex-col">
        {header}
        {error ? (
          <div className="card mx-5 mt-4 p-5">
            <p className="text-[16px]">{error}</p>
          </div>
        ) : (
          <LoadingScreen />
        )}
      </div>
    )
  }

  const { item, members, memberId, allowed } = data
  const tz = data.family.timezone
  const nowD = new Date()
  const due = dueInfo(item, nowD, tz)
  const active = isActive(item)
  const canRespond = item.status === 'pending' && allowed.includes('accept') && allowed.includes('decline')
  // a repeating item stays active after 完成: one tap here completes one occurrence
  const canDone = active && allowed.includes('done') && item.status !== 'pending' && item.status !== 'declined' && !(item.repeat && doneHere)

  return (
    <div className="mx-auto flex w-full max-w-md flex-1 flex-col pb-[calc(env(safe-area-inset-bottom)+24px)]">
      {header}
      <div className="flex flex-col gap-4 px-5 pt-2">
        <div className="sky sky-dusk p-5">
          <div className="flex flex-wrap items-center gap-2 text-[14px] text-muted">
            <span className="kind-tile h-7 w-7 rounded-lg">
              <KindIcon kind={item.kind} size={16} />
            </span>
            <span className="font-medium">{KIND_LABEL[item.kind]}</span>
            <StatusPill item={item} overdue={active && !!due?.overdue} />
          </div>
          <h1 className="mt-3 text-[24px] leading-[1.33] font-[620]">{item.title}</h1>
          {item.kind === 'request' && item.requestedBy && (
            <p className="mt-2 text-[16px]">
              {who(item.requestedBy, members, memberId)}请{who(item.ownerId, members, memberId)}帮忙
            </p>
          )}
          {due && (
            <p className={`mt-2 inline-flex items-center gap-1.5 text-[16px] ${due.overdue && active ? 'font-semibold text-danger' : ''}`}>
              <IconClock size={18} />
              <span className="when">{due.label}</span>
              {item.repeat && <span className="text-muted">· {describeRepeat(item.repeat)}</span>}
            </p>
          )}
          {item.details && <p className="well mt-3 px-3.5 py-3 text-[15px] whitespace-pre-wrap text-ink-2">{item.details}</p>}
        </div>

        {message && <p className="note bg-ok-soft text-[16px] font-semibold text-ok">{message}</p>}

        {canRespond && <RespondControl large onAccept={() => act('accept')} onDecline={m => act('decline', m)} />}

        {canDone && (
          <button
            type="button"
            className="btn btn-primary btn-lg w-full"
            disabled={busy}
            onClick={async () => {
              setBusy(true)
              try {
                await act('done')
              } catch (e) {
                setMessage(null)
                setError(errorMessage(e))
              } finally {
                setBusy(false)
              }
            }}
          >
            <IconCheck size={22} />
            {busy ? '处理中…' : '完成'}
          </button>
        )}
        {error && <p className="text-[15px] text-danger">{error}</p>}

        {!active && !message && <p className="text-center text-[15px] text-muted">这件事已经{item.status === 'done' ? '完成' : '不做'}了。</p>}

        <div className="well mt-2 px-4 py-3 text-[15px] text-ink-2">
          {isWeChat() ? (
            <>想及时收到提醒？点右上角 ··· → 在浏览器打开，安装「家庭同步」App。</>
          ) : (
            <Link
              to={`/item/${encodeURIComponent(item.id)}`}
              className="-my-3 flex min-h-[44px] items-center font-semibold text-accent-strong underline decoration-faint underline-offset-4"
            >
              在「家庭同步」App 里打开
            </Link>
          )}
        </div>
      </div>
    </div>
  )
}
