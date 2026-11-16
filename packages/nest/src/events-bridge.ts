import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import { DrishtiService } from './service.js';

/**
 * Listens to the domain events of the app (an `EventEmitter2`-like object) and counts the ones
 * that have a key in `events.map`. It reads only the event name and the fields that
 * `events.identify` returns (`person`, `group`). Other fields of the event are never read.
 */
@Injectable()
export class DrishtiEventsBridge implements OnModuleInit {
  constructor(@Inject(DrishtiService) private readonly service: DrishtiService) {}

  onModuleInit(): void {
    const events = this.service.options.events;
    if (!events) return;
    events.emitter.onAny((event, ...values) => {
      try {
        const name = Array.isArray(event) ? event.join('.') : String(event);
        const key = typeof events.map === 'function' ? events.map(name) : events.map[name];
        if (!key) return;
        const identity = events.identify ? events.identify(values[0], name) : undefined;
        this.service.collector.recordUse({
          at: Date.now(),
          key: `event:${key}`,
          who: this.service.resolveIdentity(identity),
        });
      } catch {
        this.service.collector.usageErrors++;
      }
    });
  }
}
