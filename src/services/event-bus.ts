import { EventEmitter } from 'node:events';
import type { InternalEvent } from '../types/events.js';
import type { Logger } from '../infra/logger.js';

type EventHandler = (event: InternalEvent) => void | Promise<void>;

export class EventBus {
  private readonly emitter: EventEmitter;
  private readonly logger: Logger;

  constructor(logger: Logger) {
    this.emitter = new EventEmitter();
    this.emitter.setMaxListeners(50);
    this.logger = logger;
  }

  emit(event: InternalEvent): void {
    this.logger.debug({ eventType: event.type, eventId: event.id }, 'Event emitted');
    this.emitter.emit('event', event);
    this.emitter.emit(event.type, event);
  }

  on(handler: EventHandler): void {
    this.emitter.on('event', handler);
  }

  onType(type: InternalEvent['type'], handler: EventHandler): void {
    this.emitter.on(type, handler);
  }

  off(handler: EventHandler): void {
    this.emitter.off('event', handler);
  }

  removeAllListeners(): void {
    this.emitter.removeAllListeners();
  }
}
