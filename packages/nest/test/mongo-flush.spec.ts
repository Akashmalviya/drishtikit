import { MongoClient } from 'mongodb';
import request from 'supertest';
import { Test } from '@nestjs/testing';
import { batchSize, type ApplyResult, type DrishtiStore, type FlushBatch } from '@drishtikit/core';
import { memoryStore, mongoStore } from '@drishtikit/mongo';
import { startMongo } from '../../../test-utils/mongo-memory';
import { DrishtiModule, DrishtiService } from '../src';
import { ItemsController, baseOptions, makeApp, tick, type TestApp } from './helpers';

let mongo: { uri: string; stop: () => Promise<void> };
let client: MongoClient;
beforeAll(async () => {
  mongo = await startMongo();
  client = new MongoClient(mongo.uri);
  await client.connect();
}, 60_000);
afterAll(async () => {
  await client.close();
  await mongo.stop();
}, 60_000);

const flush = (t: TestApp) => t.service.flusher.flush({ fast: true });
const hit = async (t: TestApp, n: number, user: string, path = '/items/1') => {
  for (let i = 0; i < n; i++) await request(t.app.getHttpServer()).get(path).set('x-user', user).set('x-team', 'team-a');
  await tick();
};

describe('flush with MongoDB', () => {
  it('writes the totals, and the totals add up when called again', async () => {
    const t = await makeApp(mongoStore({ client, dbName: 'flush_totals' }));
    await hit(t, 5, 'u1');
    await flush(t);
    await hit(t, 3, 'u1');
    await flush(t);
    const [day] = await t.store.find('usage_days', {});
    expect(day).toMatchObject({ n: 8, k: { 'route:GET /items/:id': 8 } });
    const people = await t.store.find('people', {});
    expect(people).toHaveLength(1);
    await t.close();
  });

  it('gives correct totals when two collectors write to the same documents at the same time', async () => {
    const a = await makeApp(mongoStore({ client, dbName: 'flush_two' }));
    const b = await makeApp(mongoStore({ client, dbName: 'flush_two' }));
    await Promise.all([hit(a, 20, 'u1'), hit(b, 30, 'u1'), hit(a, 5, 'u2', '/boom'), hit(b, 5, 'u3')]);
    await Promise.all([flush(a), flush(b)]);
    const [day] = await a.store.find('usage_days', {});
    expect(day).toMatchObject({ n: 60, e5: 5 });
    expect((day?.k as Record<string, number>)['route:GET /items/:id']).toBe(55);
    const [route] = await a.store.find('route_days', {});
    expect((route?.r as Record<string, { n: number }>)['GET /items/:id']?.n).toBe(55);
    expect(await a.store.count('people', {})).toBe(3);
    expect(await a.store.count('people_days', {})).toBe(3);
    await a.close();
    await b.close();
  });

  it('writes in parts: opsPerSecond changes, then a wait', async () => {
    const calls: Array<{ at: number; size: number }> = [];
    const inner = memoryStore();
    const store: DrishtiStore = {
      ...inner,
      apply: async (batch: FlushBatch) => {
        calls.push({ at: Date.now(), size: batchSize(batch) });
        return inner.apply(batch);
      },
    };
    const t = await makeApp(store, { flush: { opsPerSecond: 2, partDelayMs: 80 } });
    await hit(t, 1, 'u1'); // makes usage_days, route_days, people_days, people = 4 changes
    await flush(t).catch(() => undefined);
    const slow = await (async () => {
      const t2 = await makeApp(store, { flush: { opsPerSecond: 2, partDelayMs: 80 } });
      calls.length = 0;
      await hit(t2, 1, 'u1');
      const start = Date.now();
      await t2.service.flusher.flush();
      const took = Date.now() - start;
      await t2.close();
      return took;
    })();
    expect(calls.map((c) => c.size)).toEqual([2, 2]);
    expect(calls[1]!.at - calls[0]!.at).toBeGreaterThanOrEqual(70);
    expect(slow).toBeGreaterThanOrEqual(70);
    await t.close();
  });

  it('gives changes back after a failed flush, and writes them in the next flush', async () => {
    const inner = memoryStore();
    let failures = 2;
    const store: DrishtiStore = {
      ...inner,
      apply: async (batch: FlushBatch): Promise<ApplyResult> => {
        if (failures-- > 0) throw new Error('database is down');
        return inner.apply(batch);
      },
    };
    const t = await makeApp(store, { flush: { partDelayMs: 0, maxFailures: 3 } });
    await hit(t, 4, 'u1');
    await flush(t);
    expect(t.service.flusher.state.lastError).toMatch(/database is down/);
    expect(await inner.count('usage_days', {})).toBe(0);
    await hit(t, 1, 'u1'); // new samples join the ones that were given back
    await flush(t);
    expect(t.service.flusher.state.failuresInRow).toBe(2);
    await flush(t);
    const [day] = await inner.find('usage_days', {});
    expect(day?.n).toBe(5);
    expect(t.service.flusher.state.failuresInRow).toBe(0);
    expect(t.service.collector.dropped).toBe(0);
    await t.close();
  });

  it('shows what is waiting to be written, also while the database is down', async () => {
    const inner = memoryStore();
    const store: DrishtiStore = { ...inner, apply: async () => { throw new Error('down'); } };
    const t = await makeApp(store);
    await hit(t, 2, 'u1');
    await flush(t);
    expect(batchSize(t.service.pendingBatch())).toBeGreaterThan(0);
    const [op] = t.service.pendingBatch().usage_days;
    expect(op?.inc?.n).toBe(2);
    await t.close();
  });

  it('drops the changes after maxFailures failures in a row, and counts them in dropped', async () => {
    const inner = memoryStore();
    const store: DrishtiStore = { ...inner, apply: async () => { throw new Error('down'); } };
    const warnings: string[] = [];
    const t = await makeApp(store, { flush: { partDelayMs: 0, maxFailures: 3 }, warn: (m) => warnings.push(m) });
    await hit(t, 2, 'u1');
    const expected = 4; // usage_days, route_days, people_days, people
    await flush(t);
    await flush(t);
    expect(t.service.collector.dropped).toBe(0);
    await flush(t);
    expect(t.service.collector.dropped).toBe(expected);
    expect(batchSize(t.service.pendingBatch())).toBe(0);
    expect(warnings.some((w) => w.includes('dropped'))).toBe(true);
    await t.close();
  });

  it('keeps only the changes that failed when a write is partial', async () => {
    const inner = memoryStore();
    let first = true;
    const store: DrishtiStore = {
      ...inner,
      apply: async (batch: FlushBatch): Promise<ApplyResult> => {
        if (first) {
          first = false;
          const failed: FlushBatch = { ...batch, usage_days: [], route_days: [], people_days: [], people: [], trails: [], errors: [] };
          failed.people = batch.people;
          await inner.apply({ ...batch, people: [] });
          return { failed };
        }
        return inner.apply(batch);
      },
    };
    const t = await makeApp(store);
    await hit(t, 3, 'u1');
    await flush(t);
    expect(await inner.count('people', {})).toBe(0);
    await flush(t);
    expect(await inner.count('people', {})).toBe(1);
    expect((await inner.find('usage_days', {}))[0]?.n).toBe(3); // not counted twice
    await t.close();
  });

  it('keeps the app working when the store cannot start', async () => {
    const inner = memoryStore();
    let up = false;
    const store: DrishtiStore = {
      ...inner,
      start: async (r) => {
        if (!up) throw new Error('no database');
        return inner.start(r);
      },
    };
    const warnings: string[] = [];
    const moduleRef = await Test.createTestingModule({ imports: [DrishtiModule.forRoot(baseOptions(store, { warn: (m) => warnings.push(m) }))], controllers: [ItemsController] }).compile();
    const app = moduleRef.createNestApplication({ logger: false });
    await app.init();
    await request(app.getHttpServer()).get('/items/1').expect(200);
    await tick();
    const service = app.get(DrishtiService);
    await service.flusher.flush({ fast: true });
    expect(warnings.join(' ')).toContain('no database');
    up = true;
    await service.flusher.flush({ fast: true }); // the store starts now and the changes are written
    expect((await inner.find('usage_days', {}))[0]?.n).toBe(1);
    await app.close();
  });
  it('writes the day, route, people and trail documents with traits declared (0.1.0 lost the day)', async () => {
    const store = mongoStore({ client, dbName: 'flush_traits' });
    const t = await makeApp(store, {
      identify: (req) => ({
        person: req.headers['x-user'],
        group: req.headers['x-team'],
        traits: { role: req.headers['x-role'], tier: req.headers['x-tier'] },
      }),
      traits: { role: { max: 3 }, tier: { max: 3 } },
    });
    const call = async (n: number, user: string, role: string, tier: string) => {
      for (let i = 0; i < n; i++) {
        await request(t.app.getHttpServer()).get('/items/1').set('x-user', user).set('x-team', 'team-a').set('x-role', role).set('x-tier', tier);
      }
      await tick();
    };
    await call(3, 'u1', 'admin', 'free');
    await call(2, 'u2', 'member', 'free');
    await request(t.app.getHttpServer())
      .post('/drishti/events')
      .set('x-user', 'u1')
      .set('x-team', 'team-a')
      .set('x-role', 'admin')
      .set('x-tier', 'free')
      .send({ v: '1.0.0', ev: [{ t: Date.now(), k: 'tap', n: 'add_item' }] })
      .expect(204);
    await flush(t);
    expect(t.service.flusher.state.lastError).toBeNull();
    const [day] = await t.store.find('usage_days', {});
    expect(day).toBeDefined();
    expect(day).toMatchObject({ n: 5, tr: { role: { admin: 4, member: 2 }, tier: { free: 6 } } });
    expect(day?.t).toBeInstanceOf(Date);
    const [route] = await t.store.find('route_days', {});
    expect((route?.r as Record<string, { n: number }>)['GET /items/:id']?.n).toBe(5);
    const people = await t.store.find('people', {});
    expect(people).toHaveLength(2);
    expect(people.find((p) => p.traits && (p.traits as Record<string, string>).role === 'admin')).toBeDefined();
    const peopleDays = await t.store.find('people_days', {});
    expect(peopleDays).toHaveLength(2);
    expect(await t.store.count('trails', {})).toBeGreaterThan(0);
    await t.close();
  });
});
