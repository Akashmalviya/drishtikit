import { Module, type DynamicModule } from '@nestjs/common';
import { EventEmitter2 } from 'eventemitter2';
import { DrishtiModule } from '@drishtikit/nest';
import type { DrishtiStore } from '@drishtikit/core';
import { AdminController } from './admin.controller';
import { TeamsController } from './teams.controller';

export interface AcmeOptions {
  /** `null` turns Drishtikit off. Used by the load test. */
  store: DrishtiStore | null;
  key?: string;
  flushEveryMs?: number;
}

@Module({})
export class AcmeModule {
  static register(options: AcmeOptions): DynamicModule {
    const emitter = new EventEmitter2();
    const drishti = options.store
      ? [
          DrishtiModule.forRoot({
            service: 'acme-api',
            store: options.store,
            key: options.key ?? 'demo-key-demo-key-demo-key-demo-key-0000',
            timezone: 'Asia/Kolkata',
            groupLabel: 'team',
            // The app says who did it. Here the app reads headers. A real app reads its signed-in user.
            identify: (req) => ({
              person: req.headers['x-user-id'],
              group: req.headers['x-team-id'],
              traits: { role: req.headers['x-role'] },
            }),
            traits: { role: { max: 5 } },
            routes: { exclude: ['/health'] },
            events: {
              emitter,
              map: { 'member.added': 'member_added' },
              identify: (e) => ({ group: (e as { teamId: string }).teamId }),
            },
            flush: { everyMs: options.flushEveryMs ?? 300_000 },
          }),
        ]
      : [];
    return {
      module: AcmeModule,
      imports: drishti,
      controllers: options.store ? [TeamsController, AdminController] : [TeamsController],
      providers: [{ provide: EventEmitter2, useValue: emitter }],
    };
  }
}
