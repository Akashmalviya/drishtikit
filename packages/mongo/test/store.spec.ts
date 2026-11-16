import { MongoClient } from 'mongodb';
import { DEFAULT_RETENTION, emptyBatch, type DrishtiStore, type FlushBatch } from '@drishtikit/core';
import { memoryStore, mongoStore } from '../src';
import { startMongo } from '../../../test-utils/mongo-memory';

function sampleBatch(n = 1): FlushBatch {
  const batch = emptyBatch();
  batch.usage_days.push({ id: 'g1#2026-11-16', onInsert: { g: 'g1', d: '2026-11-16', t: new Date('2026-11-16T00:00:00Z') }, inc: { n, 'k.tap:add': n, 'b.2': n }, max: { mx: 90 } });
  batch.people_days.push({ id: '2026-11-16#g1#aaa', onInsert: { g: 'g1', d: '2026-11-16', p: 'aaa', t: new Date('2026-11-16T00:00:00Z') }, set: { traits: { role: 'admin' } }, addToSet: { k: ['tap:add'], h: ['09'] } });
  batch.people.push({ id: 'g1#aaa', onInsert: { g: 'g1', p: 'aaa' }, min: { first: '2026-11-16' }, max: { last: '2026-11-16', lastAt: new Date('2026-11-16T00:00:00Z') } });
  batch.trails.push({ id: '2026-11-16#g1#aaa', onInsert: { g: 'g1', d: '2026-11-16', p: 'aaa', t: new Date('2026-11-16T00:00:00Z') }, push: { ev: { each: [{ t: 1, k: 'tap:add' }], slice: -100 } } });
  batch.errors.push({ at: Date.UTC(2026, 10, 16, 10), g: 'g1', where: 'GET /x', kind: 'api', status: 500 });
  return batch;
}

let mongo: { uri: string; stop: () => Promise<void> };
let client: MongoClient;
beforeAll(async () => {
  mongo = await startMongo();
  client = new MongoClient(mongo.uri);
  await client.connect();
});
afterAll(async () => {
  await client.close();
  await mongo.stop();
});

let dbCounter = 0;
const stores: Array<[string, () => DrishtiStore]> = [
  ['memoryStore', () => memoryStore()],
  ['mongoStore', () => mongoStore({ client, dbName: `contract_${++dbCounter}` })],
];

describe.each(stores)('%s contract', (_name, make) => {
  let store: DrishtiStore;
  beforeEach(async () => {
    store = make();
    await store.start(DEFAULT_RETENTION);
  });

  it('adds changes up when the same batch is applied twice', async () => {
    expect((await store.apply(sampleBatch(2))).failed).toBeNull();
    await store.apply(sampleBatch(3));
    const [day] = await store.find('usage_days', { groups: ['g1'], from: '2026-11-16', to: '2026-11-16' });
    expect(day).toMatchObject({ _id: 'g1#2026-11-16', g: 'g1', n: 5, k: { 'tap:add': 5 }, b: { '2': 5 }, mx: 90 });
    const [person] = await store.find('people_days', { person: 'aaa' });
    expect(person).toMatchObject({ k: ['tap:add'], h: ['09'], traits: { role: 'admin' } });
    const [trail] = await store.find('trails', { person: 'aaa' });
    expect((trail?.ev as unknown[]).length).toBe(2);
  });

  it('filters by group, days, keys and first/last day', async () => {
    await store.apply(sampleBatch());
    expect(await store.count('usage_days', { groups: ['other'] })).toBe(0);
    expect(await store.count('usage_days', { from: '2026-11-17' })).toBe(0);
    expect(await store.count('people_days', { keys: ['tap:*'] })).toBe(1);
    expect(await store.count('people_days', { keys: ['screen:*'] })).toBe(0);
    expect(await store.count('people', { firstFrom: '2026-11-16', firstTo: '2026-11-16' })).toBe(1);
    expect(await store.count('people', { lastFrom: '2026-11-17' })).toBe(0);
    expect((await store.byIds('people', ['g1#aaa', 'nope'])).length).toBe(1);
  });

  it('keeps errors, newest first, with a number as time', async () => {
    const batch = sampleBatch();
    batch.errors.push({ at: Date.UTC(2026, 10, 16, 11), g: 'g1', where: 'GET /y', kind: 'browser', msg: 'oops' });
    await store.apply(batch);
    const errors = await store.find('errors', { newestFirst: true, limit: 1 });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ where: 'GET /y', at: Date.UTC(2026, 10, 16, 11) });
  });

  it('forgets one person', async () => {
    await store.apply(sampleBatch());
    expect(await store.forget('aaa')).toBe(3);
    expect(await store.count('people_days', {})).toBe(0);
    expect(await store.count('people', {})).toBe(0);
    expect(await store.count('trails', {})).toBe(0);
    expect(await store.count('usage_days', {})).toBe(1); // counters stay
  });

  it('keeps key rules', async () => {
    await store.saveRule({ name: 'Helpers', patterns: ['screen:helpers*'] });
    await store.saveRule({ name: 'Helpers', patterns: ['screen:helpers*', 'tap:helper_*'] });
    const rules = await store.rules();
    expect(rules).toHaveLength(1);
    expect(rules[0]?.patterns).toEqual(['screen:helpers*', 'tap:helper_*']);
    await store.removeRule('Helpers');
    expect(await store.rules()).toEqual([]);
  });

  it('reports its size', async () => {
    await store.apply(sampleBatch());
    expect((await store.size()).documents).toBe(5);
  });
});

describe('mongoStore specials', () => {
  it('makes the indexes and the time-to-live (TTL) on start', async () => {
    const store = mongoStore({ client, dbName: 'special_indexes' });
    await store.start({ ...DEFAULT_RETENTION, errorsDays: 7 });
    const db = client.db('special_indexes');
    const ttl = async (name: string) => (await db.collection(name).indexes()).filter((i) => i.expireAfterSeconds !== undefined);
    expect((await ttl('usage_days'))[0]).toMatchObject({ key: { t: 1 }, expireAfterSeconds: 730 * 86400 });
    expect((await ttl('route_days'))[0]).toMatchObject({ expireAfterSeconds: 90 * 86400 });
    expect((await ttl('people_days'))[0]).toMatchObject({ expireAfterSeconds: 120 * 86400 });
    expect((await ttl('people'))[0]).toMatchObject({ key: { lastAt: 1 }, expireAfterSeconds: 400 * 86400 });
    expect((await ttl('trails'))[0]).toMatchObject({ expireAfterSeconds: 14 * 86400 });
    expect((await ttl('errors'))[0]).toMatchObject({ key: { at: -1 }, expireAfterSeconds: 7 * 86400 });
    const keys = async (name: string) => (await db.collection(name).indexes()).map((i) => JSON.stringify(i.key));
    expect(await keys('people_days')).toEqual(expect.arrayContaining(['{"g":1,"d":-1}', '{"d":-1}', '{"k":1,"d":-1}']));
    expect(await keys('people')).toEqual(expect.arrayContaining(['{"g":1,"first":1}', '{"g":1,"last":1}', '{"last":1}']));
    expect(await keys('trails')).toEqual(expect.arrayContaining(['{"p":1,"d":-1}']));
    expect(await keys('usage_days')).toEqual(expect.arrayContaining(['{"d":-1}', '{"g":1,"d":-1}']));
  });

  it('changes the TTL when the setting changes, and can start twice', async () => {
    const first = mongoStore({ client, dbName: 'special_ttl' });
    await first.start({ ...DEFAULT_RETENTION, trailsDays: 14 });
    const second = mongoStore({ client, dbName: 'special_ttl' });
    await second.start({ ...DEFAULT_RETENTION, trailsDays: 30 });
    const idx = (await client.db('special_ttl').collection('trails').indexes()).find((i) => i.key.t === 1);
    expect(idx?.expireAfterSeconds).toBe(30 * 86400);
  });

  it('adds up correctly when many writers make the same new document at once', async () => {
    const stores = Array.from({ length: 4 }, () => mongoStore({ client, dbName: 'special_race' }));
    await Promise.all(stores.map((s) => s.start(DEFAULT_RETENTION)));
    const results = await Promise.all(
      Array.from({ length: 40 }, (_, i) => (stores[i % 4] as DrishtiStore).apply(sampleBatch(1))),
    );
    expect(results.every((r) => r.failed === null)).toBe(true);
    const [day] = await (stores[0] as DrishtiStore).find('usage_days', {});
    expect(day?.n).toBe(40);
  });

  it('gives back the changes that failed (partial write)', async () => {
    const store = mongoStore({ client, dbName: 'special_fail' });
    await store.start(DEFAULT_RETENTION);
    const batch = emptyBatch();
    // "n" is a number here and an array in the second change: the second change cannot apply.
    batch.usage_days.push({ id: 'ok', inc: { n: 1 } });
    batch.usage_days.push({ id: 'bad', set: { n: [1] } });
    await store.apply(batch);
    const second = emptyBatch();
    second.usage_days.push({ id: 'ok', inc: { n: 1 } }, { id: 'bad', inc: { n: 1 } });
    const result = await store.apply(second);
    expect(result.failed?.usage_days.map((o) => o.id)).toEqual(['bad']);
    const [ok] = await store.byIds('usage_days', ['ok']);
    expect(ok?.n).toBe(2);
  });

  it('refuses to start without a client or uri', () => {
    expect(() => mongoStore({})).toThrow(/client|uri/);
  });
});
