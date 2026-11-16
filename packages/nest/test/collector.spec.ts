import { createTimeKeys, applyUpdateOp, batchSize, toBuckets, percentile, type StoredDoc } from '@drishtikit/core';
import { Collector, type ApiSample } from '../src';

const limits = { maxKeysPerDay: 500, maxRoutesPerDay: 300, maxDayDocs: 5000, maxPeopleDays: 50000, maxTrails: 20000, maxErrors: 1000 };
const make = (extra: Partial<typeof limits> = {}, timeZone = 'UTC', liveSize = 3) =>
  new Collector({ timeKeys: createTimeKeys(timeZone), limits: { ...limits, ...extra }, liveSize });

const who = { person: 'aaaaaaaaaaaa', group: 'g1', traits: { role: 'admin' } };
const sample = (over: Partial<ApiSample> = {}): ApiSample => ({
  at: Date.UTC(2026, 10, 16, 9, 30),
  method: 'GET',
  route: '/items/:id',
  status: 200,
  ms: 30,
  who,
  device: 'android',
  version: '1.2.3',
  ...over,
});

function docOf(batch: ReturnType<Collector['swap']>, collection: 'usage_days' | 'route_days' | 'people_days' | 'people' | 'trails'): StoredDoc {
  expect(batch[collection]).toHaveLength(1);
  return applyUpdateOp(undefined, batch[collection][0] as never);
}

describe('Collector', () => {
  it('counts calls, errors, latency buckets, hours, keys, traits, devices and versions', () => {
    const c = make();
    c.recordApi(sample());
    c.recordApi(sample({ status: 404, ms: 120 }));
    c.recordApi(sample({ status: 503, ms: 5000, at: Date.UTC(2026, 10, 16, 10, 5) }));
    const batch = c.swap();
    const day = docOf(batch, 'usage_days');
    expect(day).toMatchObject({
      _id: 'g1#2026-11-16',
      g: 'g1',
      d: '2026-11-16',
      n: 3,
      e4: 1,
      e5: 1,
      ms: 5150,
      mx: 5000,
      k: { 'route:GET /items/:id': 3 },
      t: { role: { admin: 3 } },
      dev: { android: 3 },
      ver: { '1_2_3': 3 },
      hc: { h09: 2, h10: 1 },
      he: { h10: 1 },
    });
    expect(toBuckets(day.b)).toEqual([0, 1, 0, 1, 0, 0, 0, 0, 1]);
    expect(percentile(toBuckets(day.b), 50)).toBe(200);
    const route = docOf(batch, 'route_days');
    expect((route.r as Record<string, Record<string, number>>)['GET /items/:id']).toMatchObject({ n: 3, e4: 1, e5: 1, ms: 5150, mx: 5000 });
  });

  it('uses the time zone for the day and hour', () => {
    const c = make({}, 'Asia/Kolkata');
    c.recordApi(sample({ at: Date.UTC(2026, 10, 16, 18, 30) }));
    const day = docOf(c.swap(), 'usage_days');
    expect(day._id).toBe('g1#2026-11-17');
    expect((day.hc as Record<string, number>).h00).toBe(1);
  });

  it('keeps people, first and last day, and a trail of write calls only', () => {
    const c = make();
    c.recordApi(sample());
    c.recordApi(sample({ method: 'POST', route: '/items' }));
    const batch = c.swap();
    const pd = docOf(batch, 'people_days');
    expect(pd).toMatchObject({ _id: '2026-11-16#g1#aaaaaaaaaaaa', p: 'aaaaaaaaaaaa', traits: { role: 'admin' }, dev: 'android', h: ['09'] });
    expect((pd.k as string[]).sort()).toEqual(['route:GET /items/:id', 'route:POST /items']);
    expect(docOf(batch, 'people')).toMatchObject({ _id: 'g1#aaaaaaaaaaaa', first: '2026-11-16', last: '2026-11-16' });
    expect((docOf(batch, 'trails').ev as unknown[]).length).toBe(1);
  });

  it('counts a call with no person, and uses the group _all', () => {
    const c = make();
    c.recordApi(sample({ who: { group: '_all', traits: {} } }));
    const batch = c.swap();
    expect(batch.people_days).toHaveLength(0);
    expect(docOf(batch, 'usage_days')._id).toBe('_all#2026-11-16');
  });

  it('records a server error', () => {
    const c = make();
    c.recordApi(sample({ status: 500 }));
    expect(c.swap().errors).toEqual([{ at: Date.UTC(2026, 10, 16, 9, 30), g: 'g1', where: 'GET /items/:id', kind: 'api', status: 500, v: '1.2.3' }]);
  });

  it('starts empty after a swap and joins given-back changes into the next swap', () => {
    const c = make();
    c.recordApi(sample());
    const first = c.swap();
    expect(c.swap().usage_days).toHaveLength(0);
    c.restore(first);
    c.recordApi(sample());
    expect(docOf(c.swap(), 'usage_days').n).toBe(2);
  });

  it('shows what is pending without taking it', () => {
    const c = make();
    c.recordApi(sample());
    expect(batchSize(c.pending())).toBeGreaterThan(0);
    expect(docOf(c.swap(), 'usage_days').n).toBe(1);
  });

  it('adds to dropped when a map is full', () => {
    const c = make({ maxKeysPerDay: 1, maxRoutesPerDay: 1 });
    c.recordApi(sample({ route: '/a' }));
    c.recordApi(sample({ route: '/b' }));
    expect(c.dropped).toBeGreaterThanOrEqual(2); // a key and a route
    const small = make({ maxPeopleDays: 1 });
    small.recordApi(sample());
    small.recordApi(sample({ who: { ...who, person: 'bbbbbbbbbbbb' } }));
    expect(small.dropped).toBe(1);
    const noDays = make({ maxDayDocs: 1 });
    noDays.recordApi(sample());
    noDays.recordApi(sample({ who: { ...who, group: 'g2' } }));
    expect(noDays.dropped).toBe(1);
  });

  it('keeps a live ring with sequence numbers', () => {
    const c = make({}, 'UTC', 3);
    for (let i = 0; i < 5; i++) c.recordApi(sample({ route: `/r${i}` }));
    const all = c.live();
    expect(all.map((s) => s.seq)).toEqual([3, 4, 5]);
    expect(c.live(4).map((s) => s.seq)).toEqual([5]);
    expect(c.live(0, 1).map((s) => s.seq)).toEqual([3]);
    expect(all[0]).toMatchObject({ kind: 'api', key: 'route:GET /r2', status: 200, group: 'g1' });
  });

  it('forgets one person from memory', () => {
    const c = make();
    c.recordApi(sample({ method: 'POST' }));
    c.forgetPerson('aaaaaaaaaaaa');
    const batch = c.swap();
    expect(batch.people_days).toHaveLength(0);
    expect(batch.people).toHaveLength(0);
    expect(batch.trails).toHaveLength(0);
    expect(batch.usage_days).toHaveLength(1);
  });

  it('records uses and browser errors', () => {
    const c = make();
    c.recordUse({ at: Date.UTC(2026, 10, 16, 9), key: 'tap:add', who, props: { method: 'upi' } });
    c.recordBrowserError({ at: Date.UTC(2026, 10, 16, 9), who, where: 'items/:id', name: 'TypeError', message: 'x is undefined' });
    const batch = c.swap();
    const day = docOf(batch, 'usage_days');
    expect(day.k).toMatchObject({ 'tap:add': 1, 'error:items/:id': 1 });
    expect(day.pr).toEqual({ method: { upi: 1 } });
    expect(day.n).toBeUndefined(); // uses are not API calls
    expect(batch.errors[0]).toMatchObject({ kind: 'browser', where: 'items/:id', msg: 'TypeError: x is undefined' });
  });

  it('is fast: well under 0.1 ms for a sample', () => {
    const c = make();
    const s = sample();
    const rounds = 20000;
    const start = process.hrtime.bigint();
    for (let i = 0; i < rounds; i++) c.recordApi(s);
    const perCall = Number(process.hrtime.bigint() - start) / 1e6 / rounds;
    expect(perCall).toBeLessThan(0.1);
  });
});
