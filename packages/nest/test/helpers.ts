import 'reflect-metadata';
import { Body, Controller, Get, NotFoundException, Param, Post, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { COLLECTIONS, type DrishtiStore } from '@drishtikit/core';
import { DrishtiModule, DrishtiService, type DrishtiOptions } from '../src';

export const KEY = 'k'.repeat(32);

@Controller()
export class ItemsController {
  @Get('items/:id')
  one(@Param('id') id: string): { id: string } {
    return { id };
  }
  @Post('items')
  create(@Body() body: unknown): { ok: boolean; body: unknown } {
    return { ok: true, body };
  }
  @Get('boom')
  boom(): never {
    throw new Error('boom');
  }
  @Get('missing')
  missing(): never {
    throw new NotFoundException();
  }
  @Get('health')
  health(): string {
    return 'ok';
  }
}

export interface TestApp {
  app: INestApplication;
  service: DrishtiService;
  store: DrishtiStore;
  close: () => Promise<void>;
}

export function baseOptions(store: DrishtiStore, extra: Partial<DrishtiOptions> = {}): DrishtiOptions {
  return {
    service: 'acme-api',
    store,
    key: KEY,
    timezone: 'UTC',
    identify: (req) => ({
      person: req.headers['x-user'],
      group: req.headers['x-team'],
      traits: { role: req.headers['x-role'] },
    }),
    traits: { role: { max: 3 } },
    properties: { method: { max: 3 } },
    flush: { partDelayMs: 0 },
    ...extra,
  };
}

/** Build a Nest app with Drishtikit and a small controller. */
export async function makeApp(store: DrishtiStore, extra: Partial<DrishtiOptions> = {}): Promise<TestApp> {
  const moduleRef = await Test.createTestingModule({
    imports: [DrishtiModule.forRoot(baseOptions(store, extra))],
    controllers: [ItemsController],
  }).compile();
  const app = moduleRef.createNestApplication({ logger: false });
  await app.init();
  const service = app.get(DrishtiService);
  await service.ensureStore();
  return { app, service, store, close: () => app.close() };
}

/** Wait until the response has finished and the middleware has made its sample. */
export const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/** Everything in the store as one text, to check that something was never stored. */
export async function dumpAll(store: DrishtiStore): Promise<string> {
  const out: unknown[] = [];
  for (const name of COLLECTIONS) out.push(await store.find(name, {}));
  return JSON.stringify(out);
}
