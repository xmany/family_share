// Public surface of the notification layer.
export { createNotifier, defaultChannels } from './notifier'
export type { NotifierDeps } from './notifier'
export {
  PUSH_HEALTHY_WINDOW_MS,
  PUSH_PAYLOAD_MAX_BYTES,
  WEBPUSH_CHANNEL,
  buildPushPayload,
  countPushSubscriptions,
  createWebPushChannel,
  defaultPushSender,
  isPushHealthy,
  pushNavigateUrl,
  pushOptionsFor,
} from './webpush'
export type { PushSendOptions, PushSender, PushTarget, WebPushChannelDeps } from './webpush'
export { createWechatChannel } from './wechat'
export type { WechatChannelDeps } from './wechat'
export { Outbox } from './outbox'
export type { NewNotification } from './outbox'
export type { DeliveryResult, NotificationChannel, Notifier } from './types'
