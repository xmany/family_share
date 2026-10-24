import { EventEmitter } from 'node:events'
import type { ServerEvent } from '../shared/api'

/**
 * In-process event bus.
 * - 'server_event'        ServerEvent pushed to every connected browser over SSE
 * - 'notifications_queued' a notification row was inserted with fire_at <= now; wake the scheduler
 */
export interface BusEvents {
  server_event: [ServerEvent]
  notifications_queued: []
}

export class Bus extends EventEmitter<BusEvents> {
  broadcast(event: ServerEvent): void {
    this.emit('server_event', event)
  }
  wakeScheduler(): void {
    this.emit('notifications_queued')
  }
}
