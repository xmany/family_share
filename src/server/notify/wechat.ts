// WeChat channel adapter: delivers a ScheduledNotification as a test-account template message to the member's
// bound openid. Routing (fallback / both / only / off) is decided by the notifier; this only sends.

import type { Config } from '../config'
import type { Db } from '../db/db'
import type { Domain } from '../domain/types'
import type { Member, ScheduledNotification } from '../../shared/types'
import type { Clock } from '../time'
import type { WechatClient } from '../wechat/client'
import { sharedWechatClient } from '../wechat/client'
import { notificationLinkUrl, notificationTemplateData } from '../wechat/format'
import { WECHAT_CHANNEL, readWechatBinding, unbindWechat } from '../wechat/store'
import type { DeliveryResult, NotificationChannel } from './types'

export interface WechatChannelDeps {
  config: Pick<Config, 'publicUrl' | 'wechat'>
  db: Db
  clock: Clock
  domain: Pick<Domain, 'getItem' | 'listMembers' | 'getFamily'>
  appSecret: string
  /** Defaults to the shared client for config.wechat (one access-token cache per process). */
  client?: WechatClient
  log?: Pick<Console, 'warn' | 'error'>
}

export function createWechatChannel(deps: WechatChannelDeps): NotificationChannel {
  const { config, db, clock, domain, appSecret } = deps
  const log = deps.log ?? console

  return {
    name: WECHAT_CHANNEL,
    isConfigured: () => !!config.wechat,
    async deliver(member: Member, n: ScheduledNotification): Promise<DeliveryResult[]> {
      const wx = config.wechat
      if (!wx) return []
      const binding = readWechatBinding(db, member.id)
      if (!binding.openid || !binding.enabled || binding.mode === 'off') return []
      const now = clock.now()
      const item = n.itemId ? domain.getItem(n.itemId) : null
      const tz = domain.getFamily().timezone
      const client = deps.client ?? sharedWechatClient(wx, clock)
      const res = await client.sendTemplate({
        touser: binding.openid,
        template_id: wx.templateId,
        url: notificationLinkUrl(config.publicUrl, appSecret, n, now),
        client_msg_id: n.id,
        data: notificationTemplateData(n, { item, members: domain.listMembers(), now, tz }),
      })
      if (res.ok) return [{ channel: WECHAT_CHANNEL, ok: true }]
      if (res.unbind) {
        unbindWechat(db, member.id, clock.now())
        log.warn(`[wechat] ${res.errcode} for member ${member.id}: binding removed (${res.errmsg})`)
      }
      return [{ channel: WECHAT_CHANNEL, ok: false, permanent: res.permanent, error: `${res.errcode} ${res.errmsg}`.slice(0, 200) }]
    },
  }
}
