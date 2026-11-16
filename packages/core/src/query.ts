import { addDays, createTimeKeys, isValidDay } from './timekeys.js';

export type Metric = 'calls' | 'e4' | 'e5' | 'p50' | 'p95' | 'uses' | 'activePeople' | 'newPeople';
export type Dimension = 'group' | 'day' | 'hour' | 'route' | 'key' | 'rule' | `trait:${string}`;

export interface QueryWhere {
  /** One group or a list of groups. */
  group?: string | string[];
  /** A key pattern or a list of patterns. `*` matches any characters. For `uses` and `activePeople`. */
  key?: string | string[];
  /** A route key, for example `GET /items/:id`. For `calls`, `e4`, `e5`, `p50` and `p95`. */
  route?: string | string[];
}

export interface DrishtiQuery {
  metrics: Metric[];
  by?: Dimension[];
  where?: QueryWhere;
  /** The last N days, today included. Use this or `from` and `to`. */
  days?: number;
  /** First and last day, `YYYY-MM-DD`. */
  from?: string;
  to?: string;
}

export interface QueryRow {
  [field: string]: string | number | null;
}

export interface QueryResult {
  rows: QueryRow[];
  /** True when the answer also holds the counters that were not written yet. */
  fresh: boolean;
}

/** Which dimensions each metric can be split by. `trait:<name>` stands for any declared trait. */
export const SUPPORT_MATRIX: Readonly<Record<Metric, readonly string[]>> = {
  calls: ['group', 'day', 'route', 'hour'],
  e4: ['group', 'day', 'route'],
  e5: ['group', 'day', 'route', 'hour'],
  p50: ['group', 'day', 'route'],
  p95: ['group', 'day', 'route'],
  uses: ['group', 'day', 'key', 'rule'],
  activePeople: ['group', 'day', 'hour', 'key', 'rule', 'trait:<name>'],
  newPeople: ['group', 'day', 'trait:<name>'],
};

const ROUTE_METRICS: readonly Metric[] = ['calls', 'e4', 'e5', 'p50', 'p95'];
export const MAX_QUERY_DAYS = 800;

/** Thrown when a query asks for something that Drishtikit does not support. */
export class DrishtiQueryError extends Error {
  readonly supported: Readonly<Record<Metric, readonly string[]>> = SUPPORT_MATRIX;
  constructor(message: string) {
    super(`${message} Supported: ${describeSupport()}`);
    this.name = 'DrishtiQueryError';
  }
}

function describeSupport(): string {
  return (Object.keys(SUPPORT_MATRIX) as Metric[]).map((m) => `${m} by ${SUPPORT_MATRIX[m].join(', ')}`).join('; ') + '.';
}

/** A query that was checked and made exact. */
export interface QueryPlan {
  metrics: Metric[];
  by: Dimension[];
  groups?: string[];
  keyPatterns?: string[];
  routes?: string[];
  from: string;
  to: string;
  /** True when the route counters are needed (the query splits or filters by route). */
  useRouteDocs: boolean;
}

const list = (v: string | string[] | undefined): string[] | undefined =>
  v === undefined ? undefined : (Array.isArray(v) ? v : [v]).map(String);

export interface PlanContext {
  timeZone?: string;
  /** Epoch ms of now. For tests. */
  now?: number;
}

function isSupported(metric: Metric, dim: Dimension): boolean {
  const allowed = SUPPORT_MATRIX[metric];
  return dim.startsWith('trait:') ? allowed.includes('trait:<name>') : allowed.includes(dim);
}

/** Check a query against the support matrix and turn `days` into exact days. Throws `DrishtiQueryError`. */
export function planQuery(query: DrishtiQuery, context: PlanContext = {}): QueryPlan {
  if (!query || !Array.isArray(query.metrics) || query.metrics.length === 0) {
    throw new DrishtiQueryError('A query needs at least one metric.');
  }
  const metrics = [...new Set(query.metrics)];
  for (const metric of metrics) {
    if (!(metric in SUPPORT_MATRIX)) throw new DrishtiQueryError(`Unknown metric "${String(metric)}".`);
  }
  const by = [...new Set(query.by ?? [])];
  for (const dim of by) {
    const known = ['group', 'day', 'hour', 'route', 'key', 'rule'].includes(dim) || /^trait:[A-Za-z0-9_]{1,40}$/.test(dim);
    if (!known) throw new DrishtiQueryError(`Unknown split "${String(dim)}".`);
    for (const metric of metrics) {
      if (!isSupported(metric, dim)) throw new DrishtiQueryError(`"${metric}" cannot be split by "${dim}".`);
    }
  }
  if (by.includes('hour') && by.includes('route')) {
    throw new DrishtiQueryError('"hour" and "route" cannot be used together.');
  }

  const where = query.where ?? {};
  const groups = list(where.group);
  const keyPatterns = list(where.key);
  const routes = list(where.route)?.map((r) => r.replace(/^route:/, ''));
  if (keyPatterns && metrics.some((m) => !['uses', 'activePeople'].includes(m))) {
    throw new DrishtiQueryError('"where.key" works only with "uses" and "activePeople".');
  }
  if (routes && metrics.some((m) => !ROUTE_METRICS.includes(m))) {
    throw new DrishtiQueryError('"where.route" works only with "calls", "e4", "e5", "p50" and "p95".');
  }
  if (routes && by.includes('hour')) throw new DrishtiQueryError('"where.route" cannot be used with a split by "hour".');

  const timeKeys = createTimeKeys(context.timeZone ?? 'UTC');
  let from = query.from;
  let to = query.to;
  if (from !== undefined || to !== undefined) {
    to = to ?? timeKeys.day(context.now ?? Date.now());
    from = from ?? addDays(to, -29);
    if (!isValidDay(from) || !isValidDay(to)) throw new DrishtiQueryError('"from" and "to" must be days like 2026-11-16.');
  } else {
    const days = query.days ?? 30;
    if (!Number.isInteger(days) || days < 1 || days > MAX_QUERY_DAYS) {
      throw new DrishtiQueryError(`"days" must be a whole number from 1 to ${MAX_QUERY_DAYS}.`);
    }
    to = timeKeys.day(context.now ?? Date.now());
    from = addDays(to, -(days - 1));
  }
  if (from > to) throw new DrishtiQueryError('"from" must not be after "to".');

  const useRouteDocs = by.includes('route') || routes !== undefined;
  const plan: QueryPlan = { metrics, by, from, to, useRouteDocs };
  if (groups) plan.groups = groups;
  if (keyPatterns) plan.keyPatterns = keyPatterns;
  if (routes) plan.routes = routes;
  return plan;
}
