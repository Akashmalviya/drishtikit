import { DrishtiQueryError, SUPPORT_MATRIX, planQuery, type DrishtiQuery, type Metric } from '../src';

const NOW = Date.UTC(2026, 10, 16, 12, 0, 0);
const plan = (q: DrishtiQuery) => planQuery(q, { now: NOW });

describe('query planner: dates', () => {
  it('turns days into exact days, today included', () => {
    expect(plan({ metrics: ['calls'], days: 7 })).toMatchObject({ from: '2026-11-10', to: '2026-11-16' });
    expect(plan({ metrics: ['calls'] })).toMatchObject({ from: '2026-10-18', to: '2026-11-16' });
  });
  it('uses the time zone for today', () => {
    const late = Date.UTC(2026, 10, 16, 20, 0, 0); // 01:30 on the 17th in India
    expect(planQuery({ metrics: ['calls'], days: 1 }, { now: late, timeZone: 'Asia/Kolkata' })).toMatchObject({ from: '2026-11-17', to: '2026-11-17' });
  });
  it('takes from and to', () => {
    expect(plan({ metrics: ['calls'], from: '2026-11-01', to: '2026-11-05' })).toMatchObject({ from: '2026-11-01', to: '2026-11-05' });
    expect(plan({ metrics: ['calls'], from: '2026-11-01' })).toMatchObject({ from: '2026-11-01', to: '2026-11-16' });
  });
  it('refuses bad dates', () => {
    expect(() => plan({ metrics: ['calls'], from: '2026-13-01', to: '2026-11-05' })).toThrow(DrishtiQueryError);
    expect(() => plan({ metrics: ['calls'], from: '2026-11-06', to: '2026-11-05' })).toThrow(/not be after/);
    expect(() => plan({ metrics: ['calls'], days: 0 })).toThrow(/days/);
    expect(() => plan({ metrics: ['calls'], days: 1.5 })).toThrow(/days/);
    expect(() => plan({ metrics: ['calls'], days: 5000 })).toThrow(/days/);
  });
});

describe('query planner: support matrix', () => {
  const allDims = ['group', 'day', 'hour', 'route', 'key', 'rule', 'trait:role'] as const;

  it('accepts every combination in the matrix, one split at a time', () => {
    for (const metric of Object.keys(SUPPORT_MATRIX) as Metric[]) {
      for (const dim of SUPPORT_MATRIX[metric]) {
        const by = dim === 'trait:<name>' ? 'trait:role' : dim;
        expect(() => plan({ metrics: [metric], by: [by as never] })).not.toThrow();
      }
    }
  });

  it('refuses every combination that is not in the matrix', () => {
    for (const metric of Object.keys(SUPPORT_MATRIX) as Metric[]) {
      for (const dim of allDims) {
        const supported = SUPPORT_MATRIX[metric].includes(dim.startsWith('trait:') ? 'trait:<name>' : dim);
        if (supported) continue;
        expect(() => plan({ metrics: [metric], by: [dim] })).toThrow(DrishtiQueryError);
      }
    }
  });

  it('lists what is supported in the error', () => {
    try {
      plan({ metrics: ['p95'], by: ['key'] });
      throw new Error('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(DrishtiQueryError);
      expect((error as DrishtiQueryError).message).toContain('"p95" cannot be split by "key"');
      expect((error as DrishtiQueryError).message).toContain('activePeople by group, day, hour, key, rule, trait:<name>');
      expect((error as DrishtiQueryError).supported).toBe(SUPPORT_MATRIX);
    }
  });

  it('refuses a mix when one metric does not fit', () => {
    expect(() => plan({ metrics: ['calls', 'uses'], by: ['route'] })).toThrow(/"uses" cannot be split by "route"/);
    expect(() => plan({ metrics: ['calls', 'activePeople'], by: ['day'] })).not.toThrow();
  });

  it('refuses unknown names, empty metrics, and bad traits', () => {
    expect(() => plan({ metrics: [] })).toThrow(/at least one metric/);
    expect(() => plan({ metrics: ['bogus' as never] })).toThrow(/Unknown metric/);
    expect(() => plan({ metrics: ['uses'], by: ['nope' as never] })).toThrow(/Unknown split/);
    expect(() => plan({ metrics: ['activePeople'], by: ['trait:bad name' as never] })).toThrow(/Unknown split/);
  });

  it('refuses hour with route', () => {
    expect(() => plan({ metrics: ['calls'], by: ['hour', 'route'] })).toThrow(/together/);
    expect(() => plan({ metrics: ['calls'], by: ['hour'], where: { route: 'GET /x' } })).toThrow(/hour/);
  });

  it('checks where', () => {
    expect(() => plan({ metrics: ['calls'], where: { key: 'screen:*' } })).toThrow(/where.key/);
    expect(() => plan({ metrics: ['uses'], where: { route: 'GET /x' } })).toThrow(/where.route/);
    const p = plan({ metrics: ['uses'], where: { group: 'g1', key: ['screen:*', 'tap:*'] } });
    expect(p.groups).toEqual(['g1']);
    expect(p.keyPatterns).toEqual(['screen:*', 'tap:*']);
    expect(plan({ metrics: ['calls'], where: { route: 'route:GET /x' } }).routes).toEqual(['GET /x']);
  });

  it('chooses route counters when the query uses a route', () => {
    expect(plan({ metrics: ['calls'], by: ['route'] }).useRouteDocs).toBe(true);
    expect(plan({ metrics: ['calls'], by: ['day'] }).useRouteDocs).toBe(false);
    expect(plan({ metrics: ['p95'], where: { route: 'GET /x' } }).useRouteDocs).toBe(true);
  });
});
