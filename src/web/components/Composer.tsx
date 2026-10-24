// Chat input bar: auto-growing textarea (keyboard dictation works), send button, and a big
// hold-to-talk mic button (press and hold to record, release to send, slide up > 60 px to cancel,
// max 60 s, live timer). The mic is hidden when the server has no speech-to-text.

import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react'
import { HoldToTalkRecorder, MAX_RECORDING_MS, RecorderError, recordingSupported, type RecordingResult } from '../lib/recorder'
import { toast } from '../lib/toast'
import { IconMic, IconSend } from './Icons'

const CANCEL_DISTANCE_PX = 60
const MIN_RECORDING_MS = 600
const MAX_TEXTAREA_PX = 144

type Phase = 'idle' | 'starting' | 'recording'

function formatElapsed(ms: number): string {
  const s = Math.floor(ms / 1000)
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

export function Composer({
  sttEnabled,
  onSendText,
  onSendVoice,
  draft,
  onDraftConsumed,
}: {
  sttEnabled: boolean
  onSendText: (text: string) => void
  onSendVoice: (rec: RecordingResult) => void
  /** Text to put into the input (e.g. a tapped example) */
  draft?: string | null
  onDraftConsumed?: () => void
}) {
  const [text, setText] = useState('')
  const ta = useRef<HTMLTextAreaElement>(null)
  const micAvailable = sttEnabled && recordingSupported()

  // ---- textarea
  const resize = () => {
    const el = ta.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight + 2, MAX_TEXTAREA_PX)}px`
  }
  useLayoutEffect(resize, [text])

  useEffect(() => {
    if (draft) {
      setText(draft)
      onDraftConsumed?.()
      ta.current?.focus()
    }
  }, [draft, onDraftConsumed])

  const send = () => {
    const t = text.trim()
    if (!t) return
    onSendText(t)
    setText('')
  }

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    // Enter sends; Shift+Enter is a newline; never while an IME (pinyin) is composing.
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing && e.keyCode !== 229) {
      e.preventDefault()
      send()
    }
  }

  // ---- hold to talk
  const recRef = useRef<HoldToTalkRecorder | null>(null)
  const [phase, setPhaseState] = useState<Phase>('idle')
  const phaseRef = useRef<Phase>('idle')
  const [cancelArmed, setCancelArmedState] = useState(false)
  const cancelArmedRef = useRef(false)
  const pointerRef = useRef<number | null>(null)
  const startYRef = useRef(0)
  const [elapsed, setElapsed] = useState(0)

  const setPhase = (p: Phase) => {
    phaseRef.current = p
    setPhaseState(p)
  }
  const setCancelArmed = (v: boolean) => {
    if (cancelArmedRef.current === v) return
    cancelArmedRef.current = v
    setCancelArmedState(v)
  }

  const recorder = () => {
    if (!recRef.current) {
      const r = new HoldToTalkRecorder()
      // app switched / screen locked mid-press: the recorder dropped the take; reset the button
      r.onInterrupted = () => {
        if (phaseRef.current === 'idle') return
        pointerRef.current = null
        setCancelArmed(false)
        setPhase('idle')
      }
      recRef.current = r
    }
    return recRef.current
  }

  useEffect(
    () => () => {
      recRef.current?.dispose()
      recRef.current = null
    },
    [],
  )

  // iOS Safari: a long press would otherwise start text selection / the callout and then cancel
  // the pointer (ending the recording). React registers touch listeners as passive, so do it natively.
  const micRef = useRef<HTMLButtonElement>(null)
  const showMicButton = micAvailable && !text.trim()
  useEffect(() => {
    const el = micRef.current
    if (!el) return
    const block = (e: Event) => {
      if (e.cancelable) e.preventDefault()
    }
    el.addEventListener('touchstart', block, { passive: false })
    el.addEventListener('selectstart', block)
    return () => {
      el.removeEventListener('touchstart', block)
      el.removeEventListener('selectstart', block)
    }
  }, [showMicButton])

  useEffect(() => {
    if (phase !== 'recording') return
    setElapsed(0)
    const id = setInterval(() => setElapsed(recRef.current?.elapsedMs() ?? 0), 200)
    return () => clearInterval(id)
  }, [phase])

  const finish = async (cancel: boolean) => {
    const r = recorder()
    pointerRef.current = null
    const was = phaseRef.current
    setCancelArmed(false)
    if (was === 'starting') {
      // released before the mic was ready (or the permission prompt took the touch)
      r.cancel()
      setPhase('idle')
      toast('请按住按钮说话，松开发送')
      return
    }
    if (was !== 'recording') return
    setPhase('idle')
    if (cancel) {
      r.cancel()
      toast('已取消')
      return
    }
    if (r.elapsedMs() < MIN_RECORDING_MS) {
      r.cancel()
      toast('说话时间太短，请按住按钮说话')
      return
    }
    const result = await r.stop()
    if (!result) {
      toast('没有录到声音，请再试一次', 'danger')
      return
    }
    onSendVoice(result)
  }

  const onPointerDown = (e: PointerEvent<HTMLButtonElement>) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return
    if (phaseRef.current !== 'idle') return
    e.preventDefault()
    try {
      e.currentTarget.setPointerCapture(e.pointerId)
    } catch {
      // capture unsupported
    }
    pointerRef.current = e.pointerId
    startYRef.current = e.clientY
    setCancelArmed(false)
    setPhase('starting')
    recorder()
      .start({
        maxMs: MAX_RECORDING_MS,
        onMaxReached: () => {
          toast('最长 60 秒，已自动发送')
          void finish(false)
        },
      })
      .then(() => {
        if (phaseRef.current !== 'starting') return
        setPhase('recording')
        try {
          navigator.vibrate?.(12)
        } catch {
          // no haptics
        }
      })
      .catch((err: unknown) => {
        if (err instanceof RecorderError && err.code === 'cancelled') return
        setPhase('idle')
        pointerRef.current = null
        toast(err instanceof RecorderError ? err.message : '录音失败了，可以用键盘上的语音输入', 'danger')
      })
  }

  const onPointerMove = (e: PointerEvent<HTMLButtonElement>) => {
    if (pointerRef.current !== e.pointerId) return
    setCancelArmed(startYRef.current - e.clientY > CANCEL_DISTANCE_PX)
  }

  const onPointerUp = (e: PointerEvent<HTMLButtonElement>) => {
    if (pointerRef.current !== e.pointerId) return
    void finish(cancelArmedRef.current)
  }

  const onPointerCancel = (e: PointerEvent<HTMLButtonElement>) => {
    if (pointerRef.current !== e.pointerId) return
    void finish(true)
  }

  const remaining = Math.max(0, Math.ceil((MAX_RECORDING_MS - elapsed) / 1000))
  const showMic = showMicButton

  return (
    <div className="composer">
      {phase !== 'idle' && (
        <div
          className="pointer-events-none absolute inset-x-3 bottom-full mb-2 flex flex-col items-center gap-1.5 rounded-3xl border border-line bg-surface px-4 py-5 shadow-lg"
          role="status"
          aria-live="polite"
        >
          {phase === 'starting' ? (
            <span className="text-muted">正在打开麦克风…</span>
          ) : (
            <>
              <div className="flex items-center gap-2.5">
                <span className="rec-dot" />
                <span className="text-[28px] font-semibold tabular-nums">{formatElapsed(elapsed)}</span>
              </div>
              <span className={cancelArmed ? 'font-semibold text-danger' : 'text-muted'}>
                {cancelArmed ? '松开手指，取消发送' : remaining <= 10 ? `还能说 ${remaining} 秒` : '松开发送，上滑取消'}
              </span>
            </>
          )}
        </div>
      )}
      {!micAvailable && <p className="mb-1.5 px-2 text-[13px] text-muted">可以用键盘上的语音输入</p>}
      <div className="flex items-end gap-2">
        <textarea
          ref={ta}
          className="composer-input flex-1"
          rows={1}
          value={text}
          placeholder={micAvailable ? '打字，或按住右边说话' : '说点什么…'}
          enterKeyHint="send"
          aria-label="输入要说的话"
          onChange={e => setText(e.target.value)}
          onKeyDown={onKeyDown}
          maxLength={2000}
        />
        {showMic ? (
          <button
            ref={micRef}
            type="button"
            className="mic-btn"
            data-state={phase === 'idle' ? 'idle' : cancelArmed ? 'cancel' : 'recording'}
            aria-label="按住说话"
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerCancel}
            onContextMenu={e => e.preventDefault()}
          >
            <IconMic size={26} />
          </button>
        ) : (
          <button
            type="button"
            className="send-btn"
            aria-label="发送"
            disabled={!text.trim()}
            // keep the keyboard open: don't let the button steal focus from the textarea
            onPointerDown={e => e.preventDefault()}
            onClick={send}
          >
            <IconSend size={24} />
          </button>
        )}
      </div>
    </div>
  )
}
