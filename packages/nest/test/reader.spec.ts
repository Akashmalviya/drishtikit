import { MongoClient } from 'mongodb';
import { addDays, DrishtiQueryError, SUPPORT_MATRIX, type DrishtiStore, type Metric } from '@drishtikit/core';
import { memoryStore, mongoStore } from '@drishtikit/mongo';
import { startMongo } from '../../../test-utils/mongo-memory';
import { DrishtiReader } from '../src';
import { makeApp, type TestApp } from './helpers';

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

let dbCounter = 0;
const stores: Array<[string, () => DrishtiStore]> = [
  ['memoryStore', () => memoryStore()],
  ['mongoStore', () => mongoStore({ client, dbName: `reader_${++dbCounter}` })],
];

interface Ctx {
  t: TestApp;
  reader: DrishtiReader;
  today: string;
  day: (daysAgo: number) => string;
}

/** The test data. Part 1 is two and one day ago. Part 2 is today. See the numbers in the tests. */
function seed(t: TestApp, today: string, part: 1 | 2): void {
  const { collector } = t.service;
  const who = (person: string, group: string, role: string) => t.service.resolveIdentity({ person, group, traits: { role } });
  const A = who('A', 'g1', 'admin');
  const B = who('B', 'g1', 'member');
  const C = who('C', 'g2', 'admin');
  const D = who('D', 'g1', 'admin');
  const at = (daysAgo: number, time: string) => Date.parse(`${addDays(today, -daysAgo)}T${time}:00Z`);
  const api = (when: number, w: typeof A, route: string, status: number, ms: number, device = 'android') =>
    collector.recordApi({ at: when, method: 'GET', route, status, ms, who: w, device, version: '1.0' });
  const use = (when: number, w: typeof A, key: string, device = 'android') => collector.recordUse({ at: when, key, who: w, device, version: '1.0' });
  if (part === 1) {
    api(at(2, '12:00'), A, '/items/:id', 200, 30);
    api(at(2, '12:01'), A, '/items/:id', 200, 40);
    use(at(2, '12:02'), A, 'screen:items/:id');
    use(at(2, '12:03'), A, 'tap:helper_add');
    api(at(2, '15:00'), B, '/items', 500, 3000);
    api(at(1, '12:00'), A, '/items/:id', 200, 20);
    for (let i = 0; i < 3; i++) api(at(1, '12:00'), C, '/items/:id', 200, 10, 'ios');
    api(at(1, '12:00'), C, '/items/:id', 404, 10, 'ios');
  } else {
    api(at(0, '12:00'), A, '/items/:id', 200, 20);
    use(at(0, '12:00'), B, 'tap:helper_add');
    use(at(0, '12:01'), B, 'screen:helpers/list');
    api(at(0, '09:00'), D, '/items', 200, 100);
  }
}

async function build(make: () => DrishtiStore, scenario: 'pending' | 'flushed' | 'split', extra = {}): Promise<Ctx> {
  const t = await makeApp(make(), { cache: { ttlMs: 0 }, ...extra });
  const today = t.service.timeKeys.day(Date.now());
  seed(t, today, 1);
  if (scenario === 'split') await t.service.flusher.flush({ fast: true });
  seed(t, today, 2);
  if (scenario === 'flushed') await t.service.flusher.flush({ fast: true });
  const reader = t.app.get(DrishtiReader);
  await reader.setRule('Helpers', ['screen:helpers*', 'tap:helper_*']);
  return { t, reader, today, day: (n) => addDays(today, -n) };
}

describe.each(stores)('DrishtiReader on %s', (_name, make) => {
  describe.each(['pending', 'flushed', 'split'] as const)('data that is %s', (scenario) => {
    let c: Ctx;
    beforeEach(async () => {
      c = await build(make, scenario);
    });
    afterEach(() => c.t.close());

    const q = async (query: Parameters<DrishtiReader['query']>[0]) => (await c.reader.query(query)).rows;

    it('calls, e4, e5, p50 and p95 split by group', async () => {
      expect(await q({ metrics: ['calls', 'e4', 'e5', 'p50', 'p95'], by: ['group'] })).toEqual([
        { group: 'g1', calls: 6, e4: 0, e5: 1, p50: 50, p95: 3200 },
        { group: 'g2', calls: 4, e4: 1, e5: 0, p50: 25, p95: 25 },
      ]);
    });

    it('calls with no split, and fresh: true', async () => {
      const result = await c.reader.query({ metrics: ['calls', 'e5', 'p50', 'p95'] });
      expect(result.rows).toEqual([{ calls: 10, e5: 1, p50: 25, p95: 3200 }]);
      expect(result.fresh).toBe(true);
    });

    it('calls and p95 split by day', async () => {
      const rows = await q({ metrics: ['calls', 'p95'], by: ['day'] });
      expect(rows.map((r) => [r.day, r.calls, r.p95])).toEqual([
        [c.day(2), 3, 3200],
        [c.day(1), 5, 25],
        [c.today, 2, 100],
      ]);
    });

    it('calls and e5 split by hour', async () => {
      const rows = await q({ metrics: ['calls', 'e5'], by: ['hour'] });
      expect(rows).toEqual([
        { hour: 9, calls: 1, e5: 0 },
        { hour: 12, calls: 8, e5: 0 },
        { hour: 15, calls: 1, e5: 1 },
      ]);
    });

    it('calls split by day and hour', async () => {
      const rows = await q({ metrics: ['calls'], by: ['day', 'hour'], from: c.day(1), to: c.day(1) });
      expect(rows).toEqual([{ day: c.day(1), hour: 12, calls: 5 }]);
    });

    it('route metrics split by route, and filtered by route', async () => {
      expect(await q({ metrics: ['calls', 'e4', 'e5', 'p50', 'p95'], by: ['route'] })).toEqual([
        { route: 'GET /items', calls: 2, e4: 0, e5: 1, p50: 100, p95: 3200 },
        { route: 'GET /items/:id', calls: 8, e4: 1, e5: 0, p50: 25, p95: 50 },
      ]);
      expect(await q({ metrics: ['calls'], where: { route: 'GET /items/:id' } })).toEqual([{ calls: 8 }]);
      expect(await q({ metrics: ['calls'], where: { route: 'GET /items*' } })).toEqual([{ calls: 10 }]);
      expect(await q({ metrics: ['calls'], by: ['group', 'day', 'route'], where: { group: 'g2' } })).toEqual([{ group: 'g2', day: c.day(1), route: 'GET /items/:id', calls: 4 }]);
    });

    it('limits by days, from and to', async () => {
      expect(await q({ metrics: ['calls'], days: 1 })).toEqual([{ calls: 2 }]);
      expect(await q({ metrics: ['calls'], from: c.day(2), to: c.day(2) })).toEqual([{ calls: 3 }]);
      expect(await q({ metrics: ['calls'], by: ['day'], days: 2 })).toHaveLength(2);
    });

    it('uses split by key, rule and day, and filtered by key', async () => {
      const keys = await q({ metrics: ['uses'], by: ['key'] });
      expect(Object.fromEntries(keys.map((r) => [r.key, r.uses]))).toEqual({
        'route:GET /items/:id': 8,
        'route:GET /items': 2,
        'screen:items/:id': 1,
        'tap:helper_add': 2,
        'screen:helpers/list': 1,
      });
      expect(await q({ metrics: ['uses'], by: ['rule'] })).toEqual([{ rule: 'Helpers', uses: 3 }]);
      expect(await q({ metrics: ['uses'], by: ['rule', 'day'] })).toEqual([
        { rule: 'Helpers', day: c.day(2), uses: 1 },
        { rule: 'Helpers', day: c.today, uses: 2 },
      ]);
      expect(await q({ metrics: ['uses'], where: { key: 'tap:*' } })).toEqual([{ uses: 2 }]);
      expect(await q({ metrics: ['uses'], by: ['group'], where: { key: ['tap:*', 'screen:*'] } })).toEqual([{ group: 'g1', uses: 4 }]);
    });

    it('activePeople split by group, day and hour', async () => {
      expect(await q({ metrics: ['activePeople'] })).toEqual([{ activePeople: 4 }]);
      expect(await q({ metrics: ['activePeople'], by: ['group'] })).toEqual([
        { group: 'g1', activePeople: 3 },
        { group: 'g2', activePeople: 1 },
      ]);
      expect((await q({ metrics: ['activePeople'], by: ['day'] })).map((r) => [r.day, r.activePeople])).toEqual([
        [c.day(2), 2],
        [c.day(1), 2],
        [c.today, 3],
      ]);
      expect(await q({ metrics: ['activePeople'], by: ['hour'] })).toEqual([
        { hour: 9, activePeople: 1 },
        { hour: 12, activePeople: 3 },
        { hour: 15, activePeople: 1 },
      ]);
      expect(await q({ metrics: ['activePeople'], days: 1 })).toEqual([{ activePeople: 3 }]);
      expect(await q({ metrics: ['activePeople'], where: { group: 'g2' } })).toEqual([{ activePeople: 1 }]);
    });

    it('activePeople split by key, rule and trait', async () => {
      expect(await q({ metrics: ['activePeople'], by: ['key'], where: { key: 'tap:helper_*' } })).toEqual([{ key: 'tap:helper_add', activePeople: 2 }]);
      expect(await q({ metrics: ['activePeople'], where: { key: 'screen:*' } })).toEqual([{ activePeople: 2 }]);
      expect(await q({ metrics: ['activePeople'], by: ['rule'] })).toEqual([{ rule: 'Helpers', activePeople: 2 }]);
      expect(await q({ metrics: ['activePeople', 'uses'], by: ['rule', 'key'], where: { key: 'tap:*' } })).toEqual([{ rule: 'Helpers', key: 'tap:helper_add', activePeople: 2, uses: 2 }]);
      expect(await q({ metrics: ['activePeople'], by: ['trait:role'] })).toEqual([
        { 'trait:role': 'admin', activePeople: 3 },
        { 'trait:role': 'member', activePeople: 1 },
      ]);
      expect(await q({ metrics: ['activePeople'], by: ['group', 'trait:role'], where: { group: 'g1' } })).toEqual([
        { group: 'g1', 'trait:role': 'admin', activePeople: 2 },
        { group: 'g1', 'trait:role': 'member', activePeople: 1 },
      ]);
    });

    it('newPeople split by group, day and trait', async () => {
      expect(await q({ metrics: ['newPeople'] })).toEqual([{ newPeople: 4 }]);
      expect(await q({ metrics: ['newPeople'], by: ['group'] })).toEqual([
        { group: 'g1', newPeople: 3 },
        { group: 'g2', newPeople: 1 },
      ]);
      expect((await q({ metrics: ['newPeople'], by: ['day'] })).map((r) => [r.day, r.newPeople])).toEqual([
        [c.day(2), 2],
        [c.day(1), 1],
        [c.today, 1],
      ]);
      expect(await q({ metrics: ['newPeople'], by: ['trait:role'] })).toEqual([
        { 'trait:role': 'admin', newPeople: 3 },
        { 'trait:role': 'member', newPeople: 1 },
      ]);
      expect(await q({ metrics: ['newPeople'], days: 1 })).toEqual([{ newPeople: 1 }]);
    });

    it('joins several metrics in one row', async () => {
      const rows = await q({ metrics: ['calls', 'activePeople', 'newPeople'], by: ['group', 'day'] });
      expect(rows).toEqual([
        { group: 'g1', day: c.day(2), calls: 3, activePeople: 2, newPeople: 2 },
        { group: 'g1', day: c.day(1), calls: 1, activePeople: 1, newPeople: 0 },
        { group: 'g1', day: c.today, calls: 2, activePeople: 3, newPeople: 1 },
        { group: 'g2', day: c.day(1), calls: 4, activePeople: 1, newPeople: 1 },
      ]);
    });

    it('answers every combination of the support matrix', async () => {
      let checked = 0;
      for (const metric of Object.keys(SUPPORT_MATRIX) as Metric[]) {
        for (const dim of SUPPORT_MATRIX[metric]) {
          const by = (dim === 'trait:<name>' ? 'trait:role' : dim) as never;
          const rows = await q({ metrics: [metric], by: [by] });
          expect(rows.length).toBeGreaterThan(0);
          for (const row of rows) expect(row).toHaveProperty(by);
          checked++;
        }
      }
      expect(checked).toBe(Object.values(SUPPORT_MATRIX).reduce((n, list) => n + list.length, 0));
    });

    it('refuses combinations that are not supported', async () => {
      const refused: Array<Parameters<DrishtiReader['query']>[0]> = [
        { metrics: ['p95'], by: ['key'] },
        { metrics: ['uses'], by: ['route'] },
        { metrics: ['calls'], by: ['trait:role'] },
        { metrics: ['newPeople'], by: ['hour'] },
        { metrics: ['newPeople'], by: ['key'] },
        { metrics: ['e4'], by: ['hour'] },
        { metrics: ['calls'], by: ['hour', 'route'] },
        { metrics: ['uses'], by: ['hour'] },
        { metrics: ['activePeople'], by: ['route'] },
        { metrics: ['calls'], where: { key: 'tap:*' } },
      ];
      for (const query of refused) await expect(c.reader.query(query)).rejects.toBeInstanceOf(DrishtiQueryError);
    });

    it('overview', async () => {
      const o = await c.reader.overview();
      expect(o).toMatchObject({ calls: 10, e4: 1, e5: 1, p50: 25, p95: 3200, activePeople: { today: 3, last7: 4, last30: 4 } });
      expect(o.topRules).toEqual([{ name: 'Helpers', people: 2, uses: 3 }]);
      expect(o.busyHours).toHaveLength(7);
      expect(o.busyHours.every((d) => d.length === 24)).toBe(true);
      expect(o.busyHours.flat().reduce((a, b) => a + b, 0)).toBe(10);
      expect(o.busyHours.reduce((n, d) => n + (d[12] as number), 0)).toBe(8);
      expect((await c.reader.overview({ group: 'g2' })).calls).toBe(4);
    });

    it('rules', async () => {
      expect(await c.reader.rules()).toEqual([
        { name: 'Helpers', patterns: ['screen:helpers*', 'tap:helper_*'], people: 2, uses: 3, previousPeople: 0, previousUses: 0, peopleChange: null, usesChange: null },
      ]);
    });

    it('rules compare with the period before', async () => {
      // Period of 2 days: today and yesterday. Before it: 2 and 3 days ago, where the helper tap was used once.
      const [row] = await c.reader.rules({ days: 2 });
      expect(row).toMatchObject({ people: 1, uses: 2, previousPeople: 1, previousUses: 1, peopleChange: 0, usesChange: 1 });
    });

    it('routes', async () => {
      const r = await c.reader.routes();
      expect(r.routes.map((x) => [x.route, x.calls])).toEqual([
        ['GET /items/:id', 8],
        ['GET /items', 2],
      ]);
      expect(r.hourly.today[12]).toBe(1);
      expect(r.hourly.today[9]).toBe(1);
      expect(r.hourly.yesterday[12]).toBe(5);
    });

    it('people', async () => {
      const p = await c.reader.people();
      expect(p.activePerDay.map((x) => x.activePeople)).toEqual([2, 2, 3]);
      expect(p.newPerWeek.reduce((n, w) => n + w.newPeople, 0)).toBe(4);
      expect(p.cohorts.reduce((n, w) => n + w.size, 0)).toBe(4);
      expect(p.cohorts.every((w) => w.returnRate >= 0 && w.returnRate <= 1)).toBe(true);
      expect(p.devices).toEqual({ android: 3, ios: 1 });
      expect(p.versions).toEqual({ '1_0': 4 });
      expect(p.traits).toEqual({ role: { admin: 3, member: 1 } });
    });

    it('health', async () => {
      const h = await c.reader.health();
      expect(h).toMatchObject({ service: 'acme-api', dropped: 0, usageErrors: 0 });
      expect(h.recentErrors[0]).toMatchObject({ where: 'GET /items', status: 500, kind: 'api' });
      expect(h.slowRoutes[0]).toMatchObject({ route: 'GET /items', p95: 3200 });
      expect(h.uptimeMs).toBeGreaterThanOrEqual(0);
      expect(h.store?.documents).toBeGreaterThanOrEqual(0);
    });

    it('live', async () => {
      const all = c.reader.live();
      expect(all.length).toBe(14);
      expect(c.reader.live({ after: all[all.length - 2]!.seq }).length).toBe(1);
      expect(c.reader.live({ limit: 3 })).toHaveLength(3);
    });

    it('trail of one person, from the raw id', async () => {
      const trail = await c.reader.trail({ person: 'A' });
      expect(trail.days).toHaveLength(1);
      expect(trail.days[0]).toMatchObject({ day: c.day(2) });
      expect(trail.days[0]!.events.map((e) => e.k)).toEqual(['screen:items/:id', 'tap:helper_add']);
      expect((await c.reader.trail({ person: 'nobody' })).days).toEqual([]);
    });

    it('forget deletes one person from the store and from memory', async () => {
      const removed = await c.reader.forget('A');
      if (scenario === 'flushed') expect(removed).toBe(5); // people + 3 people_days + 1 trail
      expect(await c.reader.query({ metrics: ['activePeople'] })).toMatchObject({ rows: [{ activePeople: 3 }] });
      expect((await c.reader.trail({ person: 'A' })).days).toEqual([]);
      const byKey = await c.reader.query({ metrics: ['activePeople'], by: ['key'], where: { key: 'screen:items*' } });
      expect(byKey.rows).toEqual([]);
      // A flush after forget does not bring the person back.
      await c.t.service.flusher.flush({ fast: true });
      expect(await c.reader.query({ metrics: ['activePeople'], by: ['day'] })).toMatchObject({ rows: [{ activePeople: 1 }, { activePeople: 1 }, { activePeople: 2 }] });
      expect(await c.t.store.count('people', {})).toBe(3);
      // Counters stay: forget removes the person, not the totals.
      expect((await c.reader.query({ metrics: ['calls'] })).rows).toEqual([{ calls: 10 }]);
    });

    it('rules: a new rule counts the days that are kept, and a deleted rule is gone', async () => {
      await c.reader.setRule('Screens', ['screen:*']);
      expect((await q({ metrics: ['uses'], by: ['rule'] })).find((r) => r.rule === 'Screens')?.uses).toBe(2);
      expect((await c.reader.listRules()).map((r) => r.name).sort()).toEqual(['Helpers', 'Screens']);
      await c.reader.deleteRule('Screens');
      expect((await q({ metrics: ['uses'], by: ['rule'] })).map((r) => r.rule)).toEqual(['Helpers']);
      await expect(c.reader.setRule('', ['x'])).rejects.toThrow();
    });
  });
});

describe('DrishtiReader cache', () => {
  it('caches an answer, and clears the cache when a rule changes', async () => {
    const inner = memoryStore();
    let finds = 0;
    const store: DrishtiStore = { ...inner, find: async (...args) => (finds++, inner.find(...args)) };
    const t = await makeApp(store, { cache: { ttlMs: 60_000, max: 2 } });
    const reader = t.app.get(DrishtiReader);
    const query = { metrics: ['calls' as const] };
    await reader.query(query);
    const first = finds;
    await reader.query(query);
    expect(finds).toBe(first);
    await reader.setRule('R', ['x*']);
    await reader.query(query);
    expect(finds).toBeGreaterThan(first);
    await t.close();
  });

  it('keeps at most `max` answers', async () => {
    const inner = memoryStore();
    let finds = 0;
    const store: DrishtiStore = { ...inner, find: async (...args) => (finds++, inner.find(...args)) };
    const t = await makeApp(store, { cache: { ttlMs: 60_000, max: 2 } });
    const reader = t.app.get(DrishtiReader);
    for (const days of [1, 2, 3]) await reader.query({ metrics: ['calls'], days });
    const before = finds;
    await reader.query({ metrics: ['calls'], days: 3 }); // still cached
    expect(finds).toBe(before);
    await reader.query({ metrics: ['calls'], days: 1 }); // pushed out
    expect(finds).toBeGreaterThan(before);
    await t.close();
  });
});
