import { EventEmitter2 } from 'eventemitter2';
import request from 'supertest';
import { Module, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { memoryStore } from '@drishtikit/mongo';
import { DrishtiModule, DrishtiService } from '../src';
import { ItemsController, KEY, baseOptions, dumpAll, makeApp, tick, type TestApp } from './helpers';

const flush = (t: TestApp) => t.service.flusher.flush({ fast: true });
const http = (t: TestApp) => request(t.app.getHttpServer());

describe('middleware', () => {
  let t: TestApp;
  afterEach(() => t.close());

  it('counts calls by route pattern, not by URL', async () => {
    t = await makeApp(memoryStore());
    await http(t).get('/items/1');
    await http(t).get('/items/2');
    await http(t).get('/items/3');
    await tick();
    await flush(t);
    const [day] = await t.store.find('usage_days', {});
    expect(day).toMatchObject({ g: '_all', n: 3, k: { 'route:GET /items/:id': 3 } });
    const [routes] = await t.store.find('route_days', {});
    expect(Object.keys(routes?.r as object)).toEqual(['GET /items/:id']);
  });

  it('counts 4xx, 5xx and unmatched routes, and keeps the 5xx', async () => {
    t = await makeApp(memoryStore());
    await http(t).get('/missing');
    await http(t).get('/boom');
    await http(t).get('/nowhere/at/all');
    await tick();
    await flush(t);
    const [day] = await t.store.find('usage_days', {});
    expect(day).toMatchObject({ n: 3, e4: 2, e5: 1 });
    expect(Object.keys((day?.k as object) ?? {}).sort()).toEqual(['route:GET /boom', 'route:GET /missing', 'route:GET UNMATCHED']);
    const errors = await t.store.find('errors', {});
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ kind: 'api', status: 500, where: 'GET /boom' });
  });

  it('never keeps the query string, the body, the IP address or the User-Agent', async () => {
    t = await makeApp(memoryStore());
    await http(t).get('/items/1?email=jane@acme.test&q=secretsearch').set('User-Agent', 'Mozilla/5.0 (Linux; Android 14; SM-S911B) Chrome/120 Mobile').set('x-user', 'user-42');
    await http(t).post('/items').send({ password: 'hunter2', card: '4111111111111111' }).set('x-user', 'user-42');
    await tick();
    await flush(t);
    const all = await dumpAll(t.store);
    for (const secret of ['jane@acme.test', 'secretsearch', 'hunter2', '4111111111111111', '127.0.0.1', '::1', 'Mozilla', 'SM-S911B', 'Chrome/120', 'user-42', 'superagent']) {
      expect(all).not.toContain(secret);
    }
    expect(all).toContain('android');
  });

  it('keeps people as codes, with group and traits', async () => {
    t = await makeApp(memoryStore());
    await http(t).get('/items/1').set('x-user', 'user-42').set('x-team', 'team-a').set('x-role', 'admin');
    await tick();
    await flush(t);
    const code = t.service.codeFor('user-42');
    const [pd] = await t.store.find('people_days', { person: code });
    expect(pd).toMatchObject({ g: 'team-a', p: code, traits: { role: 'admin' } });
    const [person] = await t.store.find('people', {});
    expect(person).toMatchObject({ _id: `team-a#${code}`, traits: { role: 'admin' } });
  });

  it('refuses a trait value that looks like an email, and limits the number of values', async () => {
    const warnings: string[] = [];
    t = await makeApp(memoryStore(), { warn: (m) => warnings.push(m) });
    await http(t).get('/items/1').set('x-user', 'a').set('x-role', 'jane@acme.test');
    for (const role of ['r1', 'r2', 'r3', 'r4']) await http(t).get('/items/1').set('x-user', 'b').set('x-role', role);
    await tick();
    await flush(t);
    const all = await dumpAll(t.store);
    expect(all).not.toContain('jane@acme.test');
    expect(all).toContain('_other');
    expect(warnings.some((w) => w.includes('refused'))).toBe(true);
  });

  it('skips the excluded routes and the ingest path', async () => {
    t = await makeApp(memoryStore(), { routes: { exclude: ['/health'] } });
    await http(t).get('/health');
    await http(t).post('/drishti/events').send({ ev: [] });
    await http(t).get('/items/1');
    await tick();
    await flush(t);
    const [day] = await t.store.find('usage_days', {});
    const keys = Object.keys(day?.k as object);
    expect(keys).toEqual(['route:GET /items/:id']);
  });

  it('does not harm a request when identify throws', async () => {
    t = await makeApp(memoryStore(), {
      identify: () => {
        throw new Error('bad identify');
      },
    });
    await http(t).get('/items/1').expect(200);
    await tick();
    expect(t.service.collector.usageErrors).toBe(1);
    await flush(t);
    const [day] = await t.store.find('usage_days', {});
    expect(day?.n).toBe(1);
  });

  it('reads the app version from a header', async () => {
    t = await makeApp(memoryStore());
    await http(t).get('/items/1').set('x-app-version', '2026.11.16');
    await tick();
    await flush(t);
    const [day] = await t.store.find('usage_days', {});
    expect(day?.ver).toEqual({ '2026_11_16': 1 });
  });

  it('keeps a live feed', async () => {
    t = await makeApp(memoryStore());
    await http(t).get('/items/1');
    await tick();
    expect(t.service.collector.live()[0]).toMatchObject({ kind: 'api', key: 'route:GET /items/:id', status: 200 });
  });
});

describe('setup', () => {
  it('works with forRootAsync', async () => {
    const store = memoryStore();
    @Module({ imports: [DrishtiModule.forRootAsync({ useFactory: () => baseOptions(store) })], controllers: [ItemsController] })
    class AppModule {}
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    const app: INestApplication = moduleRef.createNestApplication({ logger: false });
    await app.init();
    await request(app.getHttpServer()).get('/items/9');
    await tick();
    await app.get(DrishtiService).flusher.flush({ fast: true });
    expect((await store.find('usage_days', {}))[0]?.n).toBe(1);
    await app.close();
  });

  it('refuses a key that is too short, and a bad time zone', async () => {
    const build = (extra: object) =>
      Test.createTestingModule({ imports: [DrishtiModule.forRoot({ ...baseOptions(memoryStore()), ...extra })] }).compile();
    await expect(build({ key: 'short' })).rejects.toThrow(/32 characters/);
    await expect(build({ timezone: 'Mars/Base' })).rejects.toThrow(/IANA/);
    await expect(build({ traits: { 'bad name': { max: 2 } } })).rejects.toThrow(/trait name/);
    await expect(build({ service: '' })).rejects.toThrow(/service/);
  });

  it('writes the counters when the app shuts down', async () => {
    const store = memoryStore();
    const t = await makeApp(store, { flush: { everyMs: 3_600_000, partDelayMs: 0 } });
    await http(t).get('/items/1');
    await tick();
    expect(await store.count('usage_days', {})).toBe(0); // not written yet
    await t.close();
    expect((await store.find('usage_days', {}))[0]?.n).toBe(1);
  });

  it('writes on the timer', async () => {
    const store = memoryStore();
    const t = await makeApp(store, { flush: { everyMs: 50, partDelayMs: 0 } });
    await http(t).get('/items/1');
    await new Promise((r) => setTimeout(r, 200));
    expect((await store.find('usage_days', {}))[0]?.n).toBe(1);
    await t.close();
  });
});

describe('domain events', () => {
  it('counts mapped events and reads only the person and group', async () => {
    const emitter = new EventEmitter2();
    const t = await makeApp(memoryStore(), {
      events: {
        emitter,
        map: { 'order.placed': 'order_placed' },
        identify: (e) => ({ person: (e as { userId: string }).userId, group: (e as { teamId: string }).teamId }),
      },
    });
    emitter.emit('order.placed', { userId: 'user-7', teamId: 't1', cardNumber: '4111111111111111', note: 'private text' });
    emitter.emit('order.cancelled', { userId: 'user-7', teamId: 't1' }); // no key: ignored
    await flush(t);
    const [day] = await t.store.find('usage_days', { groups: ['t1'] });
    expect(day?.k).toEqual({ 'event:order_placed': 1 });
    const all = await dumpAll(t.store);
    expect(all).not.toContain('4111111111111111');
    expect(all).not.toContain('private text');
    expect(all).not.toContain('user-7');
    await t.close();
  });

  it('takes a function for the map', async () => {
    const emitter = new EventEmitter2();
    const t = await makeApp(memoryStore(), { events: { emitter, map: (n) => (n.startsWith('team.') ? n.replace('team.', 'team_') : undefined) } });
    emitter.emit('team.created', {});
    emitter.emit('other', {});
    await flush(t);
    expect((await t.store.find('usage_days', {}))[0]?.k).toEqual({ 'event:team_created': 1 });
    await t.close();
  });
});

describe('ingest endpoint', () => {
  let t: TestApp;
  afterEach(() => t.close());
  const batch = (ev: unknown[], v = '1.0.0') => ({ v, ev });

  it('answers 204 and counts screens, taps and custom events', async () => {
    t = await makeApp(memoryStore());
    await http(t)
      .post('/drishti/events')
      .set('x-user', 'user-1')
      .set('User-Agent', 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)')
      .send(batch([
        { t: Date.now(), k: 'screen', n: 'items/:id' },
        { t: Date.now(), k: 'tap', n: 'add_item' },
        { t: Date.now(), k: 'custom', n: 'checkout_started', p: { method: 'upi', secretprop: 'x' } },
      ]))
      .expect(204);
    await flush(t);
    const [day] = await t.store.find('usage_days', {});
    expect(day).toMatchObject({ k: { 'screen:items/:id': 1, 'tap:add_item': 1, 'event:checkout_started': 1 }, pr: { method: { upi: 1 } }, dev: { ios: 3 }, ver: { '1_0_0': 3 } });
    expect(await dumpAll(t.store)).not.toContain('secretprop');
    expect(await dumpAll(t.store)).not.toContain('user-1');
  });

  it('drops property values that look like an email or a phone number', async () => {
    t = await makeApp(memoryStore());
    await http(t).post('/drishti/events').send(batch([{ k: 'tap', n: 'x', p: { method: 'jane@acme.test' } }, { k: 'tap', n: 'y', p: { method: '+91 98765 43210' } }])).expect(204);
    await flush(t);
    const all = await dumpAll(t.store);
    expect(all).not.toContain('jane@acme.test');
    expect(all).not.toContain('98765');
  });

  it('turns an old time or a future time into the server time', async () => {
    t = await makeApp(memoryStore());
    const before = Date.now();
    await http(t).post('/drishti/events').send(batch([
      { t: before - 3_600_000, k: 'tap', n: 'old' },
      { t: before + 3_600_000, k: 'tap', n: 'future' },
      { t: before - 60_000, k: 'tap', n: 'recent' },
    ])).expect(204);
    const live = t.service.collector.live();
    const at = Object.fromEntries(live.map((s) => [s.key, s.at]));
    expect(at['tap:old']).toBeGreaterThanOrEqual(before);
    expect(at['tap:future']).toBeGreaterThanOrEqual(before);
    expect(at['tap:future']).toBeLessThanOrEqual(Date.now());
    expect(at['tap:recent']).toBe(before - 60_000);
  });

  it('keeps browser errors with masked digits and cuts the message', async () => {
    t = await makeApp(memoryStore());
    await http(t).post('/drishti/events').send(batch([{ k: 'error', n: 'TypeError', p: { s: 'items/:id', m: `order 1234567 for 9876543210 ${'x'.repeat(200)}` } }])).expect(204);
    await flush(t);
    const [error] = await t.store.find('errors', {});
    expect(error).toMatchObject({ kind: 'browser', where: 'items/:id' });
    expect(error?.msg).toMatch(/^TypeError: order # for # x+$/);
    expect(await dumpAll(t.store)).not.toContain('9876543210');
    const [day] = await t.store.find('usage_days', {});
    expect(day?.k).toEqual({ 'error:items/:id': 1 });
  });

  it('follows keys.allow', async () => {
    t = await makeApp(memoryStore(), { keys: { allow: (n) => /^[a-z_]+$/.test(n) } });
    await http(t).post('/drishti/events').send(batch([{ k: 'tap', n: 'ok_name' }, { k: 'tap', n: 'Bad Name!' }])).expect(204);
    await flush(t);
    expect((await t.store.find('usage_days', {}))[0]?.k).toEqual({ 'tap:ok_name': 1 });
  });

  it('skips events that are not valid and keeps the valid ones', async () => {
    t = await makeApp(memoryStore());
    await http(t).post('/drishti/events').send(batch([null, 5, { k: 'nope', n: 'x' }, { k: 'tap' }, { k: 'tap', n: '' }, { k: 'tap', n: 'x'.repeat(61) }, { k: 'tap', n: 'good' }])).expect(204);
    await flush(t);
    expect((await t.store.find('usage_days', {}))[0]?.k).toEqual({ 'tap:good': 1 });
  });

  it('refuses a body that is too big (413) or has too many events (413) or is not a batch (400)', async () => {
    t = await makeApp(memoryStore(), { ingest: { maxBatch: 3, maxBytes: 400 } });
    await http(t).post('/drishti/events').send(batch(Array.from({ length: 4 }, () => ({ k: 'tap', n: 'a' })))).expect(413);
    await http(t).post('/drishti/events').send(batch([{ k: 'tap', n: 'a'.repeat(50), p: { method: 'x'.repeat(500) } }])).expect(413);
    await http(t).post('/drishti/events').send({ nothing: true }).expect(400);
    await http(t).post('/drishti/events').send('text').set('Content-Type', 'text/plain').expect(400);
  });

  it('limits the batches each minute for one person, and for one IP address when there is no person', async () => {
    t = await makeApp(memoryStore(), { ingest: { perMinute: 2 } });
    const send = (user?: string) => {
      const r = http(t).post('/drishti/events');
      if (user) r.set('x-user', user);
      return r.send(batch([{ k: 'tap', n: 'a' }]));
    };
    await send('u1').expect(204);
    await send('u1').expect(204);
    await send('u1').expect(429);
    await send('u2').expect(204); // another person has its own limit
    await send().expect(204);
    await send().expect(204);
    await send().expect(429);
    await flush(t);
    const all = await dumpAll(t.store);
    expect(all).not.toContain('127.0.0.1');
    expect(all).not.toContain('ip:');
  });

  it('can use another path', async () => {
    const store = memoryStore();
    const moduleRef = await Test.createTestingModule({ imports: [DrishtiModule.forRoot(baseOptions(store, { ingest: { path: '/api/usage' } }))] }).compile();
    const app = moduleRef.createNestApplication({ logger: false });
    await app.init();
    await request(app.getHttpServer()).post('/api/usage').send(batch([])).expect(204);
    await request(app.getHttpServer()).post('/drishti/events').send(batch([])).expect(404);
    await app.close();
    t = await makeApp(memoryStore()); // for afterEach
  });
});

describe('key', () => {
  it('KEY has 32 characters', () => expect(KEY).toHaveLength(32));
});
