// Install instructions and the notification on/off control (shared by settings, join and chat).

import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { api, errorMessage } from '../lib/api'
import { disablePush, enablePush, getPushState, PushSetupError, type PushState } from '../lib/push'
import { isAndroid, isIOS, isStandalone } from '../lib/platform'
import { toast } from '../lib/toast'
import { IconAddSquare, IconMoreVertical, IconShare } from './Icons'

function Step({ n, children }: { n: number; children: ReactNode }) {
  return (
    <li className="flex gap-3">
      <span className="flex h-6 w-6 flex-none items-center justify-center rounded-full bg-accent-soft text-[13px] font-bold text-accent-strong">
        {n}
      </span>
      <span className="min-w-0 flex-1">{children}</span>
    </li>
  )
}

export function IosInstallSteps() {
  return (
    <ol className="flex flex-col gap-2.5 text-[15px]">
      <Step n={1}>用 Safari 打开这个网页（微信里请先点右上角 ··· → 在浏览器打开）</Step>
      <Step n={2}>
        点屏幕下方的 <IconShare size={17} className="inline -mt-1 text-info" /> 分享按钮
      </Step>
      <Step n={3}>
        往下滑，选「添加到主屏幕」<IconAddSquare size={17} className="inline -mt-1 ml-0.5 text-muted" />
      </Step>
      <Step n={4}>回到主屏幕，点「家庭同步」图标打开，再开启通知</Step>
    </ol>
  )
}

export function AndroidInstallSteps() {
  return (
    <ol className="flex flex-col gap-2.5 text-[15px]">
      <Step n={1}>用 Chrome 打开这个网页（微信里请先点右上角 ··· → 在浏览器打开）</Step>
      <Step n={2}>
        点右上角的 <IconMoreVertical size={17} className="inline -mt-1" /> 菜单
      </Step>
      <Step n={3}>选「安装应用」（有的手机显示「添加到主屏幕」）</Step>
      <Step n={4}>从桌面上的「家庭同步」图标打开，再开启通知</Step>
    </ol>
  )
}

/** Both platforms, the current one first; `currentOnly` shows just this phone's steps when known. */
export function InstallGuide({ currentOnly = false }: { currentOnly?: boolean }) {
  const ios = isIOS()
  const android = !ios && isAndroid()
  let blocks = [
    { key: 'ios', title: 'iPhone', body: <IosInstallSteps /> },
    { key: 'android', title: '安卓手机', body: <AndroidInstallSteps /> },
  ]
  if (android) blocks.reverse()
  if (currentOnly && (ios || android)) blocks = blocks.slice(0, 1)
  return (
    <div className="flex flex-col gap-4">
      {blocks.map(b => (
        <div key={b.key}>
          <div className="mb-2 text-[14px] font-semibold text-muted">{b.title}</div>
          {b.body}
        </div>
      ))}
      <p className="text-[13px] text-muted">
        安卓建议把 Chrome 的电池设置改成「不受限制」，提醒才不会延迟。iPhone 的应用每次打开时可能会再问一次麦克风权限，这是正常的。
      </p>
    </div>
  )
}

export function usePushState(vapidKey: string | null) {
  const [state, setState] = useState<PushState | null>(null)
  const refresh = useCallback(() => {
    getPushState(vapidKey)
      .then(setState)
      .catch(() => setState('unsupported'))
  }, [vapidKey])
  useEffect(() => {
    refresh()
    const onVis = () => document.visibilityState === 'visible' && refresh()
    document.addEventListener('visibilitychange', onVis)
    return () => document.removeEventListener('visibilitychange', onVis)
  }, [refresh])
  return { state, refresh }
}

/**
 * Notification setup for this device. `compact` hides the test/disable buttons (onboarding).
 */
export function PushControl({
  vapidKey,
  compact = false,
  onChanged,
}: {
  vapidKey: string | null
  compact?: boolean
  onChanged?: () => void
}) {
  const { state, refresh } = usePushState(vapidKey)
  const [busy, setBusy] = useState<null | 'enable' | 'test' | 'disable'>(null)

  // Must stay a direct tap handler: enablePush() prompts as its first await.
  const onEnable = () => {
    setBusy('enable')
    enablePush(vapidKey)
      .then(() => {
        toast('通知已开启', 'ok')
        onChanged?.()
      })
      .catch(e => toast(e instanceof PushSetupError ? e.message : errorMessage(e, '开启通知失败了'), 'danger'))
      .finally(() => {
        setBusy(null)
        refresh()
      })
  }

  const onTest = async () => {
    setBusy('test')
    try {
      const r = await api.testPush()
      toast(r.delivered > 0 ? `测试通知已发送到 ${r.delivered} 台设备` : '没有可以送达的设备，请先开启通知', r.delivered > 0 ? 'ok' : 'danger')
    } catch (e) {
      toast(errorMessage(e), 'danger')
    } finally {
      setBusy(null)
    }
  }

  const onDisable = async () => {
    setBusy('disable')
    try {
      await disablePush()
      toast('这台手机的通知已关闭')
      onChanged?.()
    } finally {
      setBusy(null)
      refresh()
    }
  }

  if (state === null) return <p className="text-[15px] text-muted">正在检查通知状态…</p>

  switch (state) {
    case 'wechat':
      return <p className="text-[15px] text-warn">微信里无法开启通知。请点右上角 ··· → 在浏览器打开，安装后再开启。</p>
    case 'needs_install':
      return (
        <div className="flex flex-col gap-3">
          <p className="text-[15px]">iPhone 需要先把「家庭同步」添加到主屏幕（iOS 16.4 及以上），从主屏幕打开后才能开启通知。</p>
          <IosInstallSteps />
        </div>
      )
    case 'ios_too_old':
      return <p className="text-[15px] text-muted">这台 iPhone 的系统太旧了，升级到 iOS 16.4 或更新版本后才能开启通知。</p>
    case 'unsupported':
      return <p className="text-[15px] text-muted">这个浏览器不支持通知。iPhone 请用 Safari 添加到主屏幕，安卓请用 Chrome 安装。</p>
    case 'not_configured':
      return <p className="text-[15px] text-muted">服务器还没有配置推送通知（VAPID），请联系管理员。</p>
    case 'denied':
      return (
        <p className="text-[15px] text-danger">
          {isIOS()
            ? '通知被关闭了。请到 iPhone「设置 → 通知 → 家庭同步」打开「允许通知」，然后回到这里。'
            : '通知被拒绝了。请在 Chrome「设置 → 网站设置 → 通知」里允许本站，或在应用信息里打开通知。'}
        </p>
      )
    case 'off':
      return (
        <div className="flex flex-col gap-2.5">
          <button type="button" className="btn btn-primary btn-lg w-full" disabled={!!busy} onClick={onEnable}>
            {busy === 'enable' ? '正在开启…' : '开启通知'}
          </button>
          {isAndroid() && !isStandalone() && (
            <p className="text-[13px] text-muted">建议先安装应用：没安装的网站，Chrome 可能会自动收回通知权限。</p>
          )}
        </div>
      )
    case 'on':
      return (
        <div className="flex flex-col gap-3">
          <p className="text-[15px] font-medium text-ok">这台手机已开启通知</p>
          {!compact && (
            <div className="flex flex-wrap gap-2">
              <button type="button" className="btn btn-sm" disabled={!!busy} onClick={() => void onTest()}>
                {busy === 'test' ? '发送中…' : '发送测试通知'}
              </button>
              <button type="button" className="btn btn-sm btn-outline" disabled={!!busy} onClick={onEnable}>
                重新开启
              </button>
              <button type="button" className="btn btn-sm btn-outline" disabled={!!busy} onClick={() => void onDisable()}>
                关闭
              </button>
            </div>
          )}
        </div>
      )
  }
}
