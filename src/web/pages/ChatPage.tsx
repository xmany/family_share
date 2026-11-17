// 对话: utterances (oldest → newest), the assistant's replies, what changed, undo, clarification chips, and the
// input bar. Sending shows an optimistic 处理中… bubble.
// Two chats share the screen, switched in the header: 家里 (the family chat, everyone sees it) and 助手 (my private
// chat with the assistant: only I see it, but what it changes still lands on the shared board).

import { useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { UtteranceResponse } from '../../shared/api'
import type { Member, Utterance, UtteranceVisibility } from '../../shared/types'
import { formatInstantZh } from '../../shared/time'
import { api, errorMessage, isApiError } from '../lib/api'
import { mergeItems, upsertUtterance, useApp, useNow } from '../lib/store'
import { Link } from '../lib/router'
import { toast } from '../lib/toast'
import type { RecordingResult } from '../lib/recorder'
import { isStandalone } from '../lib/platform'
import { Composer } from '../components/Composer'
import { IconChevron, IconLock, IconMic, IconUndo } from '../components/Icons'
import { Avatar, PageHeader } from '../components/ui'
import { InstallGuide, IosInstallSteps, PushControl, usePushState } from '../components/setup'
import { ScrollContext } from '../scroll'

interface Pending {
  key: string
  kind: 'text' | 'voice'
  text: string
  status: 'sending' | 'error'
  error?: string
  /** the chat it was sent in */
  visibility: UtteranceVisibility
  /** utterance ids already on screen (in that chat) when this was sent (to spot the server's copy) */
  seen: Set<string>
  send: () => Promise<UtteranceResponse>
}

/** Chinese error for a failed send; speech-to-text failures always end with what to do instead. */
function sendErrorMessage(e: unknown): string {
  const msg = errorMessage(e, '发送失败了')
  if (!isApiError(e) || (e.code !== 'stt_failed' && e.code !== 'stt_unavailable')) return msg
  if (msg.includes('键盘')) return msg // the server already said it
  const base = msg.replace(/[。.！!，,\s]+$/u, '')
  return e.code === 'stt_unavailable' ? `${base}。请打字，或用键盘上的语音输入` : `${base}。可以再说一次，或用键盘上的语音输入`
}

const EXAMPLES = ['明天早上你能带孩子出去吗？我九点有个会', '周六下午买菜，记得买牛奶', '以后想去海边露营']
const PRIVATE_EXAMPLES = ['提醒我今晚八点给外婆打电话', '周六下午买菜，记得买牛奶', '我这周还有什么事？']
const GAP_FOR_TIME_LABEL_MS = 15 * 60_000
/** which chat was open last (this device) */
const VIEW_KEY = 'fs_chat_view'
/** createdAt of the newest family-chat line by someone else that I have looked at (this device) */
const FAMILY_SEEN_KEY = 'fs_family_seen'

/** The chat an utterance belongs to (anything not marked private is the family chat). */
const chatOf = (u: Utterance): UtteranceVisibility => (u.visibility === 'private' ? 'private' : 'family')

function latestFamilyByOthers(utterances: Utterance[], myId: string | undefined): string {
  let latest = ''
  for (const u of utterances) if (chatOf(u) === 'family' && u.memberId !== myId && u.createdAt > latest) latest = u.createdAt
  return latest
}

export function ChatPage() {
  const app = useApp()
  const board = app.board
  const nowD = useNow()
  const scroller = useContext(ScrollContext)
  const [pending, setPending] = useState<Pending[]>([])
  const [wantedView, setViewState] = useState<UtteranceVisibility>(() => (readStorage('local', VIEW_KEY) === 'private' ? 'private' : 'family'))
  // Only a server that says it keeps private utterances private gets any (an older one would file them in the family chat).
  const privateChat = app.me?.privateChat === true
  const view: UtteranceVisibility = privateChat ? wantedView : 'family'
  const [draft, setDraft] = useState<string | null>(null)
  /** once the user starts talking, the setup card gets out of the way (it lives in 设置 too) */
  const [talked, setTalked] = useState(false)
  const stickToBottom = useRef(true)

  const members = useMemo(() => new Map((board?.members ?? []).map(m => [m.id, m])), [board?.members])
  const allUtterances = useMemo(
    () => [...(board?.utterances ?? [])].sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
    [board?.utterances],
  )
  /** the chat on screen */
  const utterances = useMemo(() => allUtterances.filter(u => chatOf(u) === view), [allUtterances, view])

  const me = board?.me ?? null
  const tz = board?.family.timezone ?? 'UTC'
  const sttEnabled = app.me?.sttEnabled ?? false

  const setView = (v: UtteranceVisibility) => {
    writeStorage('local', VIEW_KEY, v)
    stickToBottom.current = true
    setViewState(v)
  }

  // ---- a dot on 家里 while I am in 助手 and someone said something there
  const familyLatest = useMemo(() => latestFamilyByOthers(allUtterances, me?.id), [allUtterances, me?.id])
  const [familySeen, setFamilySeen] = useState(() => {
    const stored = readStorage('local', FAMILY_SEEN_KEY)
    if (stored !== null) return stored
    // first time on this device: what is already there is history, not news
    const baseline = latestFamilyByOthers(board?.utterances ?? [], board?.me.id)
    writeStorage('local', FAMILY_SEEN_KEY, baseline)
    return baseline
  })
  useEffect(() => {
    if (view !== 'family' || familyLatest <= familySeen) return
    writeStorage('local', FAMILY_SEEN_KEY, familyLatest)
    setFamilySeen(familyLatest)
  }, [view, familyLatest, familySeen])
  const familyUnread = view !== 'family' && familyLatest > familySeen

  // ---- sending
  const run = useCallback(async (key: string, send: () => Promise<UtteranceResponse>) => {
    try {
      const r = await send()
      upsertUtterance(r.utterance)
      mergeItems(r.items)
      setPending(list => list.filter(p => p.key !== key))
    } catch (e) {
      setPending(list => list.map(p => (p.key === key ? { ...p, status: 'error', error: sendErrorMessage(e) } : p)))
    }
  }, [])

  const submit = useCallback(
    (kind: Pending['kind'], text: string, send: () => Promise<UtteranceResponse>) => {
      const key = `p${Date.now()}${Math.random().toString(36).slice(2, 6)}`
      const seen = new Set(utterances.map(u => u.id))
      stickToBottom.current = true
      setTalked(true)
      setPending(list => [...list, { key, kind, text, status: 'sending', visibility: view, seen, send }])
      void run(key, send)
    },
    [utterances, run, view],
  )

  // Everything is sent to the chat on screen; an answer stays in the chat of the question (the server insists on it).
  const sendText = (text: string) => submit('text', text, () => api.sendUtterance({ text, source: 'text', visibility: view }))
  const sendVoice = (r: RecordingResult) => submit('voice', '', () => api.sendVoice(r.blob, r.mimeType, r.durationMs, view))
  const answer = (u: Utterance, option: string) =>
    submit('text', option, () =>
      api.sendUtterance({ text: option, source: 'clarification', visibility: chatOf(u), replyToUtteranceId: u.id }),
    )

  const retry = (p: Pending) => {
    setPending(list => list.map(x => (x.key === p.key ? { ...x, status: 'sending', error: undefined } : x)))
    void run(p.key, p.send)
  }
  const dismiss = (p: Pending) => setPending(list => list.filter(x => x.key !== p.key))

  // Hide an optimistic bubble once the server's copy (e.g. the 'processing' utterance via SSE) is here.
  const pendingHere = pending.filter(p => p.visibility === view)
  const visiblePending = pendingHere.filter(
    p =>
      p.status === 'error' ||
      !utterances.some(
        u => !p.seen.has(u.id) && u.memberId === me?.id && (p.kind === 'voice' ? u.source === 'voice' : u.text === p.text),
      ),
  )

  const lastMineId = useMemo(() => {
    for (let i = utterances.length - 1; i >= 0; i--) if (utterances[i]!.memberId === me?.id) return utterances[i]!.id
    return null
  }, [utterances, me?.id])

  // ---- scrolling: start at the bottom (also after switching chats), follow new messages while the user is near the bottom
  useLayoutEffect(() => {
    const el = scroller.current
    if (el) el.scrollTop = el.scrollHeight
  }, [scroller, view])

  useEffect(() => {
    const el = scroller.current
    if (!el) return
    const onScroll = () => {
      stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 140
    }
    el.addEventListener('scroll', onScroll, { passive: true })
    // keyboard opening / composer growing shrinks the scroller: keep the latest message in view
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => {
      if (stickToBottom.current) el.scrollTop = el.scrollHeight
    }) : null
    ro?.observe(el)
    return () => {
      el.removeEventListener('scroll', onScroll)
      ro?.disconnect()
    }
  }, [scroller])

  const lastU = utterances[utterances.length - 1]
  const contentKey = `${utterances.length}:${lastU?.id}:${lastU?.status}:${visiblePending.length}:${visiblePending.map(p => p.status).join()}`
  useEffect(() => {
    const el = scroller.current
    if (el && stickToBottom.current) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })
  }, [contentKey, scroller])

  if (!board || !me) return null

  return (
    <div className="page">
      <PageHeader title="对话" right={privateChat ? <ChatSwitch view={view} onChange={setView} familyUnread={familyUnread} /> : undefined} />
      <div className="flex flex-1 flex-col gap-1 px-3 pb-3">
        {utterances.length === 0 && visiblePending.length === 0 && <EmptyChat view={view} onPick={setDraft} sttEnabled={sttEnabled} />}
        {utterances.map((u, i) => {
          const prev = utterances[i - 1]
          const showTime =
            !prev || new Date(u.createdAt).getTime() - new Date(prev.createdAt).getTime() > GAP_FOR_TIME_LABEL_MS
          return (
            <div key={u.id}>
              {showTime && <TimeLabel text={formatInstantZh(u.createdAt, nowD, tz)} />}
              <UtteranceView
                u={u}
                mine={u.memberId === me.id}
                speaker={members.get(u.memberId)}
                canAnswer={u.id === lastMineId && pendingHere.length === 0}
                onAnswer={opt => answer(u, opt)}
              />
            </div>
          )
        })}
        {visiblePending.map(p => (
          <PendingView key={p.key} p={p} onRetry={() => retry(p)} onDismiss={() => dismiss(p)} />
        ))}
        {/* at the bottom, where the chat opens: the onboarding card must be seen */}
        {!talked && <SetupNudge vapidKey={app.me?.vapidPublicKey ?? null} name={me.name} />}
      </div>
      <Composer
        sttEnabled={sttEnabled}
        onSendText={sendText}
        onSendVoice={sendVoice}
        draft={draft}
        onDraftConsumed={() => setDraft(null)}
        note={
          view === 'private' ? (
            <>
              <IconLock size={14} className="flex-none" />
              只有你和助手看得到
            </>
          ) : undefined
        }
      />
    </div>
  )
}

function ChatSwitch({
  view,
  onChange,
  familyUnread,
}: {
  view: UtteranceVisibility
  onChange: (v: UtteranceVisibility) => void
  familyUnread: boolean
}) {
  return (
    <div className="seg" role="tablist" aria-label="和谁说">
      <button type="button" role="tab" className="seg-btn" aria-selected={view === 'family'} onClick={() => onChange('family')}>
        家里
        {familyUnread && <span className="seg-dot" role="img" aria-label="有新消息" />}
      </button>
      <button type="button" role="tab" className="seg-btn" aria-selected={view === 'private'} onClick={() => onChange('private')}>
        <IconLock size={15} />
        助手
      </button>
    </div>
  )
}

function TimeLabel({ text }: { text: string }) {
  return <div className="time-sep">{text}</div>
}

function SpeakerLine({ member }: { member: Member | undefined }) {
  return (
    <div className="mb-1.5 flex items-center gap-2 pl-0.5">
      <Avatar member={member} size={26} />
      <span className="text-[14px] font-medium text-muted">{member?.name ?? '家人'}</span>
    </div>
  )
}

function Dots() {
  return (
    <span className="dots inline-flex gap-0.5" aria-hidden="true">
      <span>·</span>
      <span>·</span>
      <span>·</span>
    </span>
  )
}

function UtteranceView({
  u,
  mine,
  speaker,
  canAnswer,
  onAnswer,
}: {
  u: Utterance
  mine: boolean
  speaker: Member | undefined
  canAnswer: boolean
  onAnswer: (option: string) => void
}) {
  const options = u.status === 'clarify' ? (u.clarification?.options ?? []) : []
  const replyText =
    u.status === 'clarify' ? (u.clarification?.question ?? u.reply) : u.status === 'error' ? (u.error ?? u.reply) : u.reply
  return (
    <div className="py-1.5">
      {mine ? (
        <div className="flex justify-end">
          <div className={`bubble bubble-me ${u.status === 'undone' ? 'opacity-60' : ''}`}>
            {u.source === 'voice' && <IconMic size={15} className="mr-1 inline -mt-0.5 text-accent" />}
            {u.text || (u.source === 'voice' ? '（语音）' : '')}
          </div>
        </div>
      ) : (
        <div>
          <SpeakerLine member={speaker} />
          <div className="flex">
            <div className={`bubble bubble-other ${u.status === 'undone' ? 'opacity-60' : ''}`}>
              {u.source === 'voice' && <IconMic size={15} className="mr-1 inline -mt-0.5 text-muted" />}
              {u.text || (u.source === 'voice' ? '（语音）' : '')}
            </div>
          </div>
        </div>
      )}

      <div className={`mt-2 flex flex-col items-start gap-2 ${mine ? '' : 'pl-[34px]'}`}>
        {u.status === 'processing' ? (
          <div className="bubble bubble-reply text-muted">
            处理中<Dots />
          </div>
        ) : u.status === 'error' ? (
          <div className="bubble bubble-error">{replyText || '出错了，请再说一次'}</div>
        ) : replyText ? (
          <div className="bubble bubble-reply">{replyText}</div>
        ) : null}

        {options.length > 0 && canAnswer && (
          <div className="flex flex-wrap gap-2 pt-0.5">
            {options.map(opt => (
              <button key={opt} type="button" className="chip chip-answer" onClick={() => onAnswer(opt)}>
                {opt}
              </button>
            ))}
          </div>
        )}

        {u.changes.length > 0 && <ChangesCard u={u} mine={mine} />}
      </div>
    </div>
  )
}

function ChangesCard({ u, mine }: { u: Utterance; mine: boolean }) {
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)
  const undone = u.status === 'undone'
  const canUndo = mine && !undone && u.status !== 'processing'

  useEffect(() => {
    if (!confirming) return
    const t = setTimeout(() => setConfirming(false), 4000)
    return () => clearTimeout(t)
  }, [confirming])

  const undo = async () => {
    if (!confirming) {
      setConfirming(true)
      return
    }
    setBusy(true)
    try {
      const r = await api.undo(u.id)
      upsertUtterance(r.utterance)
      mergeItems(r.items)
      toast('已撤销')
    } catch (e) {
      toast(errorMessage(e, '撤销失败了'), 'danger')
    } finally {
      setBusy(false)
      setConfirming(false)
    }
  }

  return (
    <div className="card w-full max-w-[92%] overflow-hidden">
      <div className="flex min-h-[44px] items-center justify-between gap-2 py-1 pr-1.5 pl-4">
        <span className="caps">{undone ? '改动（已撤销）' : '改动'}</span>
        {canUndo && (
          <button
            type="button"
            className={`btn btn-sm ${confirming ? 'btn-danger' : 'btn-ghost'}`}
            disabled={busy}
            onClick={() => void undo()}
          >
            <IconUndo size={16} />
            {busy ? '撤销中…' : confirming ? '确定撤销？' : '撤销'}
          </button>
        )}
      </div>
      <ul>
        {u.changes.map(c => {
          const inner = (
            <>
              <span className={`min-w-0 flex-1 text-[15px] leading-snug ${undone ? 'text-muted line-through decoration-faint' : ''}`}>
                {c.summary}
              </span>
              {c.itemId && <IconChevron size={18} className="flex-none text-faint" />}
            </>
          )
          return (
            <li key={c.eventId} className="border-t border-line">
              {c.itemId ? (
                <Link
                  to={`/item/${encodeURIComponent(c.itemId)}`}
                  className="flex min-h-[48px] items-center gap-2 px-4 py-2.5 active:bg-surface-2"
                >
                  {inner}
                </Link>
              ) : (
                <div className="flex min-h-[48px] items-center gap-2 px-4 py-2.5">{inner}</div>
              )}
            </li>
          )
        })}
      </ul>
    </div>
  )
}

function PendingView({ p, onRetry, onDismiss }: { p: Pending; onRetry: () => void; onDismiss: () => void }) {
  return (
    <div className="py-1.5">
      <div className="flex justify-end">
        <div className="bubble bubble-me">
          {p.kind === 'voice' ? (
            <>
              <IconMic size={15} className="mr-1 inline -mt-0.5 text-accent" />
              语音
            </>
          ) : (
            p.text
          )}
        </div>
      </div>
      <div className="mt-2 flex flex-col items-start gap-2">
        {p.status === 'sending' ? (
          <div className="bubble bubble-reply text-muted">
            {p.kind === 'voice' ? '正在听' : '处理中'}
            <Dots />
          </div>
        ) : (
          <>
            <div className="bubble bubble-error">{p.error}</div>
            <div className="flex gap-2">
              <button type="button" className="btn btn-sm" onClick={onRetry}>
                重试
              </button>
              <button type="button" className="btn btn-sm btn-ghost" onClick={onDismiss}>
                算了
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}

function EmptyChat({ view, onPick, sttEnabled }: { view: UtteranceVisibility; onPick: (text: string) => void; sttEnabled: boolean }) {
  const isPrivate = view === 'private'
  return (
    <div className="flex flex-1 flex-col justify-center py-6">
      <div className="sky sky-dusk flex flex-col gap-3 p-5">
        <p className="text-[20px] leading-snug font-[620]">{isPrivate ? '只跟助手说' : '说一句话，家里的事就安排好了'}</p>
        {isPrivate && (
          <p className="text-[15px] text-ink-2">
            这里说的话和助手的回复，只有你自己看得到。事情照样记到大家的看板上，请家人帮忙时他们会收到通知。
          </p>
        )}
        <p className="text-[15px] text-ink-2">
          {sttEnabled ? '打字，或按住麦克风说话。' : '打字，或用键盘上的语音输入。'}比如：
        </p>
        <div className="mt-1 flex flex-col items-start gap-2">
          {(isPrivate ? PRIVATE_EXAMPLES : EXAMPLES).map(ex => (
            <button key={ex} type="button" className="chip" onClick={() => onPick(ex)}>
              {ex}
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}

const NUDGE_KEY = 'fs_setup_nudge_until'
const JOINED_KEY = 'fs_just_joined'

function readStorage(store: 'local' | 'session', key: string): string | null {
  try {
    return (store === 'local' ? localStorage : sessionStorage).getItem(key)
  } catch {
    return null
  }
}
function writeStorage(store: 'local' | 'session', key: string, value: string | null) {
  try {
    const s = store === 'local' ? localStorage : sessionStorage
    if (value === null) s.removeItem(key)
    else s.setItem(key, value)
  } catch {
    // storage unavailable (private mode)
  }
}

/** After joining: welcome + install + notifications. Later: a dismissible nudge while push is off. */
function SetupNudge({ vapidKey, name }: { vapidKey: string | null; name: string }) {
  const { state } = usePushState(vapidKey)
  const [joined, setJoined] = useState(() => readStorage('session', JOINED_KEY) === '1')
  const [snoozedUntil, setSnoozedUntil] = useState(() => Number(readStorage('local', NUDGE_KEY) ?? 0))
  const [showSteps, setShowSteps] = useState(false)
  const standalone = isStandalone()

  if (joined) {
    return (
      <div className="sky sky-dawn mt-3 flex flex-col gap-5 p-5">
        <div>
          <p className="text-[20px] leading-snug font-[620]">欢迎，{name}！</p>
          <p className="mt-1 text-[15px] text-ink-2">两步设置好，家人找你时就能马上收到提醒。</p>
        </div>
        {!standalone && (
          <div>
            <p className="mb-2.5 font-semibold">第一步：添加到主屏幕</p>
            <InstallGuide currentOnly />
          </div>
        )}
        <div>
          <p className="mb-2.5 font-semibold">{standalone ? '开启通知' : '第二步：开启通知'}</p>
          <PushControl vapidKey={vapidKey} compact />
        </div>
        <button
          type="button"
          className="btn"
          onClick={() => {
            writeStorage('session', JOINED_KEY, null)
            setJoined(false)
          }}
        >
          知道了
        </button>
      </div>
    )
  }

  if (Date.now() < snoozedUntil) return null
  const later = () => {
    const until = Date.now() + 3 * 24 * 3600_000
    writeStorage('local', NUDGE_KEY, String(until))
    setSnoozedUntil(until)
  }

  if (state === 'off') {
    return (
      <div className="card mt-3 flex flex-col gap-3 p-5">
        <p className="text-[15px]">开启通知，家人请你帮忙、事情快到时间时，手机会提醒你。</p>
        <PushControl vapidKey={vapidKey} compact />
        <button type="button" className="btn btn-sm btn-ghost self-start" onClick={later}>
          以后再说
        </button>
      </div>
    )
  }
  if (state === 'needs_install') {
    return (
      <div className="card mt-3 flex flex-col gap-3 p-5">
        <p className="text-[15px]">把「家庭同步」添加到主屏幕，才能收到提醒。</p>
        {showSteps && <IosInstallSteps />}
        <div className="flex gap-2">
          {!showSteps && (
            <button type="button" className="btn btn-sm" onClick={() => setShowSteps(true)}>
              怎么添加
            </button>
          )}
          <button type="button" className="btn btn-sm btn-ghost" onClick={later}>
            以后再说
          </button>
        </div>
      </div>
    )
  }
  return null
}

export function markJustJoined(): void {
  writeStorage('session', JOINED_KEY, '1')
}
