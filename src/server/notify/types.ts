import type { ChannelSetting, PushSubscribeBody } from '../../shared/api'
import type { Member, ScheduledNotification } from '../../shared/types'

export interface DeliveryResult {
  channel: string
  ok: boolean
  error?: string
  /** true when retrying cannot help (e.g. 410 Gone, bad token) */
  permanent?: boolean
}

/** One way of reaching a phone: web push, ntfy, a WeChat relay, … */
export interface NotificationChannel {
  readonly name: string
  /** Server-level configuration present (keys, tokens). */
  isConfigured(): boolean
  /**
   * Delivers to every endpoint this member has on this channel. Returns one result per endpoint
   * (empty array when the member has no endpoint on this channel).
   */
  deliver(member: Member, n: ScheduledNotification): Promise<DeliveryResult[]>
}

export interface Notifier {
  /** Names of configured channels, e.g. ["webpush", "ntfy"] */
  channels(): string[]
  /** Fans a notification out to all of the member's enabled channels. */
  deliver(n: ScheduledNotification): Promise<DeliveryResult[]>
  vapidPublicKey(): string | null
  savePushSubscription(memberId: string, sub: PushSubscribeBody['subscription'], userAgent?: string | null): void
  removePushSubscription(endpoint: string): void
  /** Number of push subscriptions a member has (for the settings screen) */
  pushSubscriptionCount(memberId: string): number
  getMemberChannels(memberId: string): ChannelSetting[]
  setMemberChannels(memberId: string, settings: ChannelSetting[]): ChannelSetting[]
}
