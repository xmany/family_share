// Shows a fresh invite link: copy, share, and a QR code to scan from the new phone.

import { useEffect, useState } from 'react'
import { toString as qrToString } from 'qrcode'
import type { InviteResponse } from '../../shared/api'
import { formatInstantZh } from '../../shared/time'
import { copyText, shareOrCopy, toast } from '../lib/toast'
import { now } from '../lib/store'
import { IconClose, IconCopy, IconShare } from './Icons'

export function InvitePanel({ invite, tz, onClose }: { invite: InviteResponse; tz: string; onClose: () => void }) {
  const [svg, setSvg] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    qrToString(invite.inviteUrl, {
      type: 'svg',
      margin: 1,
      errorCorrectionLevel: 'M',
      color: { dark: '#000000', light: '#ffffff' },
    })
      .then(s => !cancelled && setSvg(s))
      .catch(() => !cancelled && setSvg(null))
    return () => {
      cancelled = true
    }
  }, [invite.inviteUrl])

  const copy = async () => {
    const ok = await copyText(invite.inviteUrl)
    toast(ok ? '邀请链接已复制' : '复制失败，请长按链接手动复制', ok ? 'ok' : 'danger')
  }

  return (
    <div className="card flex flex-col gap-3 p-4">
      <div className="flex items-start justify-between gap-2">
        <p className="text-[16px] font-semibold">给{invite.member.name}的邀请</p>
        <button type="button" className="icon-btn -mt-2 -mr-2" aria-label="关闭" onClick={onClose}>
          <IconClose size={20} />
        </button>
      </div>
      <p className="text-[14px] text-muted">
        在{invite.member.name}的手机上打开这个链接：iPhone 用 Safari，安卓用 Chrome。也可以用新手机的相机扫下面的二维码。
      </p>
      <div className="rounded-xl bg-surface-2 px-3 py-2.5 font-mono text-[13px] break-all select-all">{invite.inviteUrl}</div>
      <div className="flex gap-2">
        <button type="button" className="btn btn-primary flex-1" onClick={() => void copy()}>
          <IconCopy size={18} />
          复制链接
        </button>
        <button
          type="button"
          className="btn flex-1"
          onClick={() =>
            void shareOrCopy({ title: '加入家庭同步', text: `${invite.member.name}，点这个链接加入我们的家庭同步：`, url: invite.inviteUrl })
          }
        >
          <IconShare size={18} />
          发送
        </button>
      </div>
      {svg && (
        // an <img> (not injected markup): nothing in the SVG can ever run or style the page
        <img
          className="mx-auto w-52 rounded-xl bg-white p-2"
          src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`}
          alt="邀请链接二维码"
        />
      )}
      <p className="text-[12.5px] text-muted">
        有效到 {formatInstantZh(invite.expiresAt, now(), tz)}，最多可用 5 次（iPhone 加到主屏幕后可能要在应用里再加入一次）。在微信里打开的话，先点右上角 ··· → 在浏览器打开。
      </p>
    </div>
  )
}
