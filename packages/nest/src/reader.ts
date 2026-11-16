import { Inject, Injectable } from '@nestjs/common';
import {
  addDays,
  applyUpdateOp,
  matchDoc,
  matchesAny,
  percentile,
  planQuery,
  rulesForKey,
  toBuckets,
  validateRule,
  weekStart,
  emptyBuckets,
  addBuckets,
  type CollectionName,
  type Dimension,
  type DocFilter,
  type DrishtiQuery,
  type KeyRule,
  type Metric,
  type QueryPlan,
  type QueryResult,
  type QueryRow,
  type StoredDoc,
  type StoreSize,
} from '@drishtikit/core';
import type { FlushState } from './flusher.js';
import type { LiveSample } from './collector.js';
import { DrishtiService } from './service.js';

export interface PeriodOptions {
  /** One group. Without it, all groups together. */
  group?: string;
  /** The last N days, today included. Default 30. */
  days?: number;
}

export interface OverviewResult {
  days: number;
  activePeople: { today: number; last7: number; last30: number };
  calls: number;
  e4: number;
  e5: number;
  p50: number;
  p95: number;
  topRules: Array<{ name: string; people: number; uses: number }>;
  /** Calls by weekday (0 = Monday) and hour (0 to 23). */
  busyHours: number[][];
}

export interface RuleRow {
  name: string;
  patterns: string[];
  people: number;
  uses: number;
  previousPeople: number;
  previousUses: number;
  /** Change against the period before, as a fraction (0.25 = 25% more). `null` when the period before had none. */
  peopleChange: number | null;
  usesChange: number | null;
}

export interface RouteRow {
  route: string;
  calls: number;
  e4: number;
  e5: number;
  p50: number;
  p95: number;
}

export interface RoutesResult {
  routes: RouteRow[];
  hourly: { today: number[]; yesterday: number[] };
}

export interface PeopleResult {
  activePerDay: Array<{ day: string; activePeople: number }>;
  newPerWeek: Array<{ week: string; newPeople: number }>;
  /** For each first week: how many people came, and how many came back in a later week. */
  cohorts: Array<{ week: string; size: number; returned: number; returnRate: number }>;
  devices: Record<string, number>;
  versions: Record<string, number>;
  traits: Record<string, Record<string, number>>;
}

export interface HealthResult {
  service: string;
  version: string | undefined;
  env: string | undefined;
  groupLabel: string;
  uptimeMs: number;
  flush: FlushState;
  dropped: number;
  usageErrors: number;
  recentErrors: Array<{ at: number; group: string; where: string; kind: string; status?: number; msg?: string }>;
  slowRoutes: Array<{ route: string; calls: number; p95: number }>;
  store: StoreSize | null;
}

export interface TrailResult {
  days: Array<{ day: string; events: Array<{ t: number; k: string }> }>;
}

type Dims = Record<string, string | number>;
interface Cell {
  dims: Dims;
  values: Record<string, number>;
}
interface RouteAcc {
  n: number;
  e4: number;
  e5: number;
  mx: number;
  b: number[];
}

const ROUTE_METRICS: readonly Metric[] = ['calls', 'e4', 'e5', 'p50', 'p95'];
const SEP = '\u0001';
const pad = (n: number): string => String(n).padStart(2, '0');
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

/**
 * Read functions. It opens no endpoint. Put it behind your own guarded endpoints.
 * Each answer holds the counters that were not written yet, and is cached for a short time.
 */
@Injectable()
export class DrishtiReader {
  private readonly cache = new Map<string, { at: number; value: unknown }>();

  constructor(@Inject(DrishtiService) private readonly service: DrishtiService) {}

  // ---- query() ----

  /**
   * One flexible read. See `SUPPORT_MATRIX` for what can be split by what.
   * Throws `DrishtiQueryError` for a combination that is not supported.
   */
  async query(query: DrishtiQuery): Promise<QueryResult> {
    const plan = planQuery(query, { timeZone: this.service.options.timezone });
    return this.cached(`q:${JSON.stringify(plan)}`, async () => ({ rows: await this.run(plan), fresh: true }));
  }

  // ---- ready functions ----

  async overview(options: PeriodOptions = {}): Promise<OverviewResult> {
    const days = options.days ?? 30;
    const where = options.group !== undefined ? { group: options.group } : undefined;
    return this.cached(`overview:${JSON.stringify(options)}`, async () => {
      const [today, last7, last30, totals, rules, busy] = await Promise.all([
        this.query({ metrics: ['activePeople'], days: 1, where }),
        this.query({ metrics: ['activePeople'], days: 7, where }),
        this.query({ metrics: ['activePeople'], days: 30, where }),
        this.query({ metrics: ['calls', 'e4', 'e5', 'p50', 'p95'], days, where }),
        this.rules(options),
        this.query({ metrics: ['calls'], by: ['day', 'hour'], days, where }),
      ]);
      const total = totals.rows[0] ?? {};
      const busyHours = Array.from({ length: 7 }, () => new Array<number>(24).fill(0));
      for (const row of busy.rows) {
        const weekday = (new Date(`${row.day as string}T00:00:00Z`).getUTCDay() + 6) % 7;
        (busyHours[weekday] as number[])[row.hour as number]! += num(row.calls);
      }
      return {
        days,
        activePeople: { today: num(today.rows[0]?.activePeople), last7: num(last7.rows[0]?.activePeople), last30: num(last30.rows[0]?.activePeople) },
        calls: num(total.calls),
        e4: num(total.e4),
        e5: num(total.e5),
        p50: num(total.p50),
        p95: num(total.p95),
        topRules: [...rules]
          .sort((a, b) => b.uses - a.uses)
          .slice(0, 5)
          .map((r) => ({ name: r.name, people: r.people, uses: r.uses })),
        busyHours,
      };
    });
  }

  /** People and uses for each key rule, with the change against the period before. */
  async rules(options: PeriodOptions = {}): Promise<RuleRow[]> {
    const days = options.days ?? 30;
    const where = options.group !== undefined ? { group: options.group } : undefined;
    return this.cached(`rules:${JSON.stringify(options)}`, async () => {
      const rules = await this.service.store.rules();
      if (rules.length === 0) return [];
      const plan = planQuery({ metrics: ['uses'], days }, { timeZone: this.service.options.timezone });
      const prevTo = addDays(plan.from, -1);
      const prevFrom = addDays(prevTo, -(days - 1));
      const [cur, prev] = await Promise.all([
        this.query({ metrics: ['activePeople', 'uses'], by: ['rule'], from: plan.from, to: plan.to, where }),
        this.query({ metrics: ['activePeople', 'uses'], by: ['rule'], from: prevFrom, to: prevTo, where }),
      ]);
      const pick = (rows: QueryRow[], name: string): QueryRow | undefined => rows.find((r) => r.rule === name);
      const change = (now: number, before: number): number | null => (before === 0 ? null : (now - before) / before);
      return rules.map((rule) => {
        const c = pick(cur.rows, rule.name);
        const p = pick(prev.rows, rule.name);
        const people = num(c?.activePeople);
        const uses = num(c?.uses);
        const previousPeople = num(p?.activePeople);
        const previousUses = num(p?.uses);
        return { name: rule.name, patterns: rule.patterns, people, uses, previousPeople, previousUses, peopleChange: change(people, previousPeople), usesChange: change(uses, previousUses) };
      });
    });
  }

  async routes(options: PeriodOptions = {}): Promise<RoutesResult> {
    const days = options.days ?? 30;
    const where = options.group !== undefined ? { group: options.group } : undefined;
    return this.cached(`routes:${JSON.stringify(options)}`, async () => {
      const [byRoute, hours] = await Promise.all([
        this.query({ metrics: ['calls', 'e4', 'e5', 'p50', 'p95'], by: ['route'], days, where: { ...where } }),
        this.query({ metrics: ['calls'], by: ['day', 'hour'], days: 2, where }),
      ]);
      const today = this.service.timeKeys.day(Date.now());
      const yesterday = addDays(today, -1);
      const hourly = { today: new Array<number>(24).fill(0), yesterday: new Array<number>(24).fill(0) };
      for (const row of hours.rows) {
        if (row.day === today) (hourly.today[row.hour as number] as number) += num(row.calls);
        else if (row.day === yesterday) (hourly.yesterday[row.hour as number] as number) += num(row.calls);
      }
      const routes = byRoute.rows
        .map((r) => ({ route: r.route as string, calls: num(r.calls), e4: num(r.e4), e5: num(r.e5), p50: num(r.p50), p95: num(r.p95) }))
        .sort((a, b) => b.calls - a.calls);
      return { routes, hourly };
    });
  }

  async people(options: PeriodOptions = {}): Promise<PeopleResult> {
    const days = options.days ?? 30;
    const where = options.group !== undefined ? { group: options.group } : undefined;
    return this.cached(`people:${JSON.stringify(options)}`, async () => {
      const plan = planQuery({ metrics: ['activePeople'], days, where }, { timeZone: this.service.options.timezone });
      const filter: DocFilter = { from: plan.from, to: plan.to, ...(plan.groups ? { groups: plan.groups } : {}) };
      const [perDay, fresh, peopleDays, cohortPeople] = await Promise.all([
        this.query({ metrics: ['activePeople'], by: ['day'], days, where }),
        this.query({ metrics: ['newPeople'], by: ['day'], days, where }),
        this.read('people_days', filter),
        this.read('people', { firstFrom: weekStart(plan.from), firstTo: plan.to, ...(plan.groups ? { groups: plan.groups } : {}) }),
      ]);
      const weeks = new Map<string, number>();
      for (const row of fresh.rows) {
        const w = weekStart(row.day as string);
        weeks.set(w, (weeks.get(w) ?? 0) + num(row.newPeople));
      }
      const cohortMap = new Map<string, { size: number; returned: number }>();
      for (const person of cohortPeople) {
        const week = weekStart(person.first as string);
        const c = cohortMap.get(week) ?? { size: 0, returned: 0 };
        c.size++;
        if ((person.last as string) >= addDays(week, 7)) c.returned++;
        cohortMap.set(week, c);
      }
      const devices = new Map<string, Set<string>>();
      const versions = new Map<string, Set<string>>();
      const traits = new Map<string, Map<string, Set<string>>>();
      const add = (map: Map<string, Set<string>>, key: string, p: string): void => {
        (map.get(key) ?? map.set(key, new Set()).get(key)!).add(p);
      };
      for (const doc of peopleDays) {
        const p = doc.p as string;
        if (typeof doc.dev === 'string') add(devices, doc.dev, p);
        if (typeof doc.ver === 'string') add(versions, doc.ver, p);
        for (const [name, value] of Object.entries((doc.traits as Record<string, string> | undefined) ?? {})) {
          const byValue = traits.get(name) ?? traits.set(name, new Map()).get(name)!;
          add(byValue, value, p);
        }
      }
      const sizes = (m: Map<string, Set<string>>): Record<string, number> => Object.fromEntries([...m].map(([k, v]) => [k, v.size]));
      return {
        activePerDay: perDay.rows.map((r) => ({ day: r.day as string, activePeople: num(r.activePeople) })),
        newPerWeek: [...weeks].sort(([a], [b]) => (a < b ? -1 : 1)).map(([week, newPeople]) => ({ week, newPeople })),
        cohorts: [...cohortMap]
          .sort(([a], [b]) => (a < b ? -1 : 1))
          .map(([week, c]) => ({ week, size: c.size, returned: c.returned, returnRate: c.size === 0 ? 0 : c.returned / c.size })),
        devices: sizes(devices),
        versions: sizes(versions),
        traits: Object.fromEntries([...traits].map(([name, byValue]) => [name, sizes(byValue)])),
      };
    });
  }

  /** The state of Drishtikit itself. Not cached. */
  async health(): Promise<HealthResult> {
    const { service } = this;
    let size: StoreSize | null = null;
    try {
      size = await service.store.size();
    } catch {
      size = null;
    }
    const stored = await service.store.find('errors', { newestFirst: true, limit: 20 }).catch(() => [] as StoredDoc[]);
    const pending = service.pendingBatch().errors.map((e) => ({ ...e }));
    const recent = [...pending, ...stored.map((e) => ({ at: e.at as number, g: e.g as string, where: e.where as string, kind: e.kind as 'api' | 'browser', status: e.status as number | undefined, msg: e.msg as string | undefined }))]
      .sort((a, b) => b.at - a.at)
      .slice(0, 20)
      .map((e) => ({ at: e.at, group: e.g, where: e.where, kind: e.kind, status: e.status, msg: e.msg }));
    const routes = await this.query({ metrics: ['calls', 'p95'], by: ['route'], days: 7 }).catch(() => ({ rows: [] as QueryRow[] }));
    const slowRoutes = routes.rows
      .map((r) => ({ route: r.route as string, calls: num(r.calls), p95: num(r.p95) }))
      .sort((a, b) => b.p95 - a.p95)
      .slice(0, 5);
    return {
      service: service.options.service,
      version: service.options.version,
      env: service.options.env,
      groupLabel: service.options.groupLabel,
      uptimeMs: Date.now() - service.startedAt,
      flush: { ...service.flusher.state },
      dropped: service.collector.dropped,
      usageErrors: service.collector.usageErrors,
      recentErrors: recent,
      slowRoutes,
      store: size,
    };
  }

  /** Samples after a sequence number, from memory of this server only. */
  live(options: { after?: number; limit?: number } = {}): LiveSample[] {
    return this.service.collector.live(options.after ?? 0, options.limit ?? 200);
  }

  /** The events of one person. Give the raw id; the reader makes the code. */
  async trail(options: { person: string | number; days?: number }): Promise<TrailResult> {
    const days = options.days ?? 14;
    const to = this.service.timeKeys.day(Date.now());
    const docs = await this.read('trails', { person: this.service.codeFor(options.person), from: addDays(to, -(days - 1)), to });
    const byDay = new Map<string, Array<{ t: number; k: string }>>();
    for (const doc of docs) {
      const list = byDay.get(doc.d as string) ?? [];
      list.push(...((doc.ev as Array<{ t: number; k: string }>) ?? []));
      byDay.set(doc.d as string, list);
    }
    return { days: [...byDay].sort(([a], [b]) => (a < b ? -1 : 1)).map(([day, events]) => ({ day, events: events.sort((a, b) => a.t - b.t) })) };
  }

  async listRules(): Promise<KeyRule[]> {
    return this.service.store.rules();
  }

  /** Make or change a key rule. The rule also counts the past days that are still kept. */
  async setRule(name: string, patterns: string[]): Promise<void> {
    const rule = validateRule(name, patterns);
    await this.service.store.saveRule(rule);
    this.cache.clear();
  }

  async deleteRule(name: string): Promise<void> {
    await this.service.store.removeRule(name);
    this.cache.clear();
  }

  /**
   * Erase one person: the people, people_days and trails documents, and anything of that person
   * that waits in memory. Give the raw id. Returns how many documents were deleted.
   */
  async forget(person: string | number): Promise<number> {
    const code = this.service.codeFor(person);
    this.service.collector.forgetPerson(code);
    await this.service.flusher.waitIdle();
    const removed = await this.service.store.forget(code);
    this.service.collector.forgetPerson(code); // changes that were given back after a failed write
    this.cache.clear();
    return removed;
  }

  // ---- internals ----

  private async cached<T>(key: string, compute: () => Promise<T>): Promise<T> {
    const { ttlMs, max } = this.service.options.cache;
    const hit = this.cache.get(key);
    if (hit && Date.now() - hit.at < ttlMs) return hit.value as T;
    const value = await compute();
    if (ttlMs > 0) {
      this.cache.delete(key);
      this.cache.set(key, { at: Date.now(), value });
      while (this.cache.size > max) this.cache.delete(this.cache.keys().next().value as string);
    }
    return value;
  }

  /** Read from the store and add the counters that were not written yet (the memory merge). */
  private async read(collection: Exclude<CollectionName, 'errors'>, filter: DocFilter): Promise<StoredDoc[]> {
    const { store } = this.service;
    const stored = await store.find(collection, filter);
    const ops = this.service.pendingBatch()[collection];
    if (ops.length === 0) return stored;
    const result = new Map<string, StoredDoc>(stored.map((d) => [String(d._id), d]));
    const missing = ops.filter((op) => !result.has(op.id)).map((op) => op.id);
    const others = missing.length > 0 ? await store.byIds(collection, missing) : [];
    const known = new Map<string, StoredDoc>([...result, ...others.map((d): [string, StoredDoc] => [String(d._id), d])]);
    for (const op of ops) {
      const merged = applyUpdateOp(known.get(op.id), op);
      if (matchDoc(collection, filter, merged)) result.set(op.id, merged);
      else result.delete(op.id);
    }
    return [...result.values()];
  }

  private async run(plan: QueryPlan): Promise<QueryRow[]> {
    const needsRules = plan.by.includes('rule');
    const rules = needsRules ? await this.service.store.rules() : [];
    const table = new Map<string, Cell>();
    const cell = (dims: Dims): Cell => {
      const key = plan.by.map((d) => String(dims[d])).join(SEP);
      let c = table.get(key);
      if (!c) {
        c = { dims, values: {} };
        table.set(key, c);
      }
      return c;
    };
    const routeMetrics = plan.metrics.filter((m) => ROUTE_METRICS.includes(m));
    if (routeMetrics.length > 0) await this.runRoute(plan, routeMetrics, cell);
    if (plan.metrics.includes('uses')) await this.runUses(plan, rules, cell);
    if (plan.metrics.includes('activePeople')) await this.runActive(plan, rules, cell);
    if (plan.metrics.includes('newPeople')) await this.runNew(plan, cell);

    const rows: QueryRow[] = [];
    for (const c of table.values()) {
      const row: QueryRow = { ...c.dims };
      for (const m of plan.metrics) row[m] = c.values[m] ?? 0;
      rows.push(row);
    }
    return rows.sort((a, b) => {
      for (const dim of plan.by) {
        const x = a[dim] as string | number;
        const y = b[dim] as string | number;
        if (x !== y) return x < y ? -1 : 1;
      }
      return 0;
    });
  }

  private baseFilter(plan: QueryPlan): DocFilter {
    return { from: plan.from, to: plan.to, ...(plan.groups ? { groups: plan.groups } : {}) };
  }

  private async runRoute(plan: QueryPlan, metrics: Metric[], cell: (dims: Dims) => Cell): Promise<void> {
    const accs = new Map<string, { dims: Dims; acc: RouteAcc }>();
    const bucket = (dims: Dims): RouteAcc => {
      const key = plan.by.map((d) => String(dims[d])).join(SEP);
      let entry = accs.get(key);
      if (!entry) {
        entry = { dims, acc: { n: 0, e4: 0, e5: 0, mx: 0, b: emptyBuckets() } };
        accs.set(key, entry);
      }
      return entry.acc;
    };
    const dimsOf = (g: string, d: string, route?: string, hour?: number): Dims => {
      const dims: Dims = {};
      for (const dim of plan.by) {
        if (dim === 'group') dims.group = g;
        else if (dim === 'day') dims.day = d;
        else if (dim === 'route') dims.route = route as string;
        else if (dim === 'hour') dims.hour = hour as number;
      }
      return dims;
    };
    const fold = (acc: RouteAcc, src: Record<string, unknown>): void => {
      acc.n += num(src.n);
      acc.e4 += num(src.e4);
      acc.e5 += num(src.e5);
      acc.mx = Math.max(acc.mx, num(src.mx));
      addBuckets(acc.b, toBuckets(src.b));
    };

    if (plan.useRouteDocs) {
      for (const doc of await this.read('route_days', this.baseFilter(plan))) {
        for (const [name, raw] of Object.entries((doc.r as Record<string, Record<string, unknown>>) ?? {})) {
          if (plan.routes && !matchesAny(name, plan.routes)) continue;
          fold(bucket(dimsOf(doc.g as string, doc.d as string, name)), raw);
        }
      }
    } else if (plan.by.includes('hour')) {
      for (const doc of await this.read('usage_days', this.baseFilter(plan))) {
        const hc = (doc.hc as Record<string, number>) ?? {};
        const he = (doc.he as Record<string, number>) ?? {};
        for (let h = 0; h < 24; h++) {
          const calls = num(hc[`h${pad(h)}`]);
          const e5 = num(he[`h${pad(h)}`]);
          if (calls === 0 && e5 === 0) continue;
          const acc = bucket(dimsOf(doc.g as string, doc.d as string, undefined, h));
          acc.n += calls;
          acc.e5 += e5;
        }
      }
    } else {
      for (const doc of await this.read('usage_days', this.baseFilter(plan))) fold(bucket(dimsOf(doc.g as string, doc.d as string)), doc);
    }
    for (const { dims, acc } of accs.values()) {
      const c = cell(dims);
      for (const m of metrics) {
        c.values[m] = m === 'calls' ? acc.n : m === 'e4' ? acc.e4 : m === 'e5' ? acc.e5 : m === 'p50' ? percentile(acc.b, 50, acc.mx) : percentile(acc.b, 95, acc.mx);
      }
    }
  }

  private async runUses(plan: QueryPlan, rules: KeyRule[], cell: (dims: Dims) => Cell): Promise<void> {
    const wantsKey = plan.by.includes('key');
    const wantsRule = plan.by.includes('rule');
    for (const doc of await this.read('usage_days', this.baseFilter(plan))) {
      for (const [key, count] of Object.entries((doc.k as Record<string, number>) ?? {})) {
        if (plan.keyPatterns && !matchesAny(key, plan.keyPatterns)) continue;
        const ruleNames = wantsRule ? rulesForKey(key, rules) : [undefined];
        for (const rule of ruleNames) {
          const dims: Dims = {};
          for (const dim of plan.by) {
            if (dim === 'group') dims.group = doc.g as string;
            else if (dim === 'day') dims.day = doc.d as string;
            else if (dim === 'key' && wantsKey) dims.key = key;
            else if (dim === 'rule') dims.rule = rule as string;
          }
          const c = cell(dims);
          c.values.uses = (c.values.uses ?? 0) + num(count);
        }
      }
    }
  }

  private async runActive(plan: QueryPlan, rules: KeyRule[], cell: (dims: Dims) => Cell): Promise<void> {
    const wantsHour = plan.by.includes('hour');
    const wantsKey = plan.by.includes('key');
    const wantsRule = plan.by.includes('rule');
    const today = this.service.timeKeys.day(Date.now());

    // Fast path: people active since a day, up to today. This reads the `people` documents
    // (index on `last`) and also works for periods longer than the kept days of `people_days`.
    if (plan.by.every((d) => d === 'group') && !plan.keyPatterns && plan.to >= today) {
      const filter: DocFilter = { lastFrom: plan.from, ...(plan.groups ? { groups: plan.groups } : {}) };
      for (const doc of await this.read('people', filter)) {
        const c = cell(plan.by.includes('group') ? { group: doc.g as string } : {});
        c.values.activePeople = (c.values.activePeople ?? 0) + 1;
      }
      return;
    }
    if (wantsRule && rules.length === 0) return;

    const keyFilter = plan.keyPatterns ?? (wantsRule ? rules.flatMap((r) => r.patterns) : undefined);
    const filter: DocFilter = { ...this.baseFilter(plan), ...(keyFilter ? { keys: keyFilter } : {}) };
    const sets = new Map<string, { dims: Dims; people: Set<string> }>();
    const traitDims = plan.by.filter((d): d is Dimension & `trait:${string}` => d.startsWith('trait:'));

    for (const doc of await this.read('people_days', filter)) {
      const allKeys = (doc.k as string[]) ?? [];
      const keys = plan.keyPatterns ? allKeys.filter((k) => matchesAny(k, plan.keyPatterns as string[])) : allKeys;
      const hours = wantsHour ? ((doc.h as string[]) ?? []).map(Number) : [undefined];
      let pairs: Array<{ key?: string; rule?: string }>;
      if (wantsKey && wantsRule) pairs = keys.flatMap((key) => rulesForKey(key, rules).map((rule) => ({ key, rule })));
      else if (wantsKey) pairs = keys.map((key) => ({ key }));
      else if (wantsRule) pairs = [...new Set(keys.flatMap((k) => rulesForKey(k, rules)))].map((rule) => ({ rule }));
      else pairs = [{}];
      const traits = (doc.traits as Record<string, string> | undefined) ?? {};
      for (const hour of hours) {
        for (const pair of pairs) {
          const dims: Dims = {};
          for (const dim of plan.by) {
            if (dim === 'group') dims.group = doc.g as string;
            else if (dim === 'day') dims.day = doc.d as string;
            else if (dim === 'hour') dims.hour = hour as number;
            else if (dim === 'key') dims.key = pair.key as string;
            else if (dim === 'rule') dims.rule = pair.rule as string;
          }
          for (const t of traitDims) dims[t] = traits[t.slice(6)] ?? '_none';
          const id = plan.by.map((d) => String(dims[d])).join(SEP);
          let entry = sets.get(id);
          if (!entry) {
            entry = { dims, people: new Set() };
            sets.set(id, entry);
          }
          entry.people.add(doc.p as string);
        }
      }
    }
    for (const { dims, people } of sets.values()) cell(dims).values.activePeople = people.size;
  }

  private async runNew(plan: QueryPlan, cell: (dims: Dims) => Cell): Promise<void> {
    const filter: DocFilter = { firstFrom: plan.from, firstTo: plan.to, ...(plan.groups ? { groups: plan.groups } : {}) };
    for (const doc of await this.read('people', filter)) {
      const traits = (doc.traits as Record<string, string> | undefined) ?? {};
      const dims: Dims = {};
      for (const dim of plan.by) {
        if (dim === 'group') dims.group = doc.g as string;
        else if (dim === 'day') dims.day = doc.first as string;
        else if (dim.startsWith('trait:')) dims[dim] = traits[dim.slice(6)] ?? '_none';
      }
      const c = cell(dims);
      c.values.newPeople = (c.values.newPeople ?? 0) + 1;
    }
  }
}
