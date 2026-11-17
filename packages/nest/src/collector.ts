import {
  batchSize,
  bucketIndex,
  cleanKey,
  dayToDate,
  emptyBatch,
  mergeBatch,
  BUCKET_COUNT,
  type ErrorDoc,
  type FlushBatch,
  type TimeKeys,
  type UpdateOp,
} from '@drishtikit/core';
import type { LimitsOptions } from './options.js';

/** Who did it, after cleaning. `person` is a person code, never a raw id. */
export interface ResolvedIdentity {
  person?: string;
  group: string;
  traits: Record<string, string>;
}

export interface ApiSample {
  at: number;
  method: string;
  /** The route pattern, for example `/items/:id`, or `UNMATCHED`. */
  route: string;
  status: number;
  ms: number;
  who: ResolvedIdentity;
  device: string;
  version?: string;
}

export interface UseSample {
  at: number;
  /** A full key, for example `screen:items/:id`. */
  key: string;
  who: ResolvedIdentity;
  device?: string;
  version?: string;
  /** Cleaned event properties (declared names only). */
  props?: Record<string, string>;
}

export interface BrowserErrorSample {
  at: number;
  who: ResolvedIdentity;
  /** The screen where the error happened. */
  where: string;
  name: string;
  message: string;
  device?: string;
  version?: string;
}

/** One entry of the live ring. */
export interface LiveSample {
  seq: number;
  at: number;
  group: string;
  kind: 'api' | 'use';
  key: string;
  status?: number;
  ms?: number;
  person?: string;
}

export interface CollectorConfig {
  timeKeys: TimeKeys;
  limits: Required<LimitsOptions>;
  liveSize: number;
}

interface DayAcc {
  g: string;
  d: string;
  n: number;
  e4: number;
  e5: number;
  ms: number;
  mx: number;
  b: number[];
  k: Map<string, number>;
  t: Map<string, number>;
  dev: Map<string, number>;
  ver: Map<string, number>;
  pr: Map<string, number>;
  hc: number[];
  he: number[];
}

interface RouteAcc {
  n: number;
  e4: number;
  e5: number;
  ms: number;
  mx: number;
  b: number[];
}

interface PersonDayAcc {
  g: string;
  d: string;
  p: string;
  traits: Record<string, string>;
  dev?: string;
  ver?: string;
  k: Set<string>;
  h: Set<number>;
}

interface PersonAcc {
  g: string;
  p: string;
  first: string;
  last: string;
  traits: Record<string, string>;
}

interface TrailAcc {
  g: string;
  d: string;
  p: string;
  ev: Array<{ t: number; k: string }>;
}

interface Counters {
  days: Map<string, DayAcc>;
  routes: Map<string, Map<string, RouteAcc>>;
  peopleDays: Map<string, PersonDayAcc>;
  people: Map<string, PersonAcc>;
  trails: Map<string, TrailAcc>;
  errors: ErrorDoc[];
}

const MAX_KEYS_PER_PERSON_DAY = 200;
const MAX_TRAIL_EVENTS = 100;
const WRITE_METHODS_ONLY = new Set(['GET', 'HEAD', 'OPTIONS']);
const hh = (hour: number): string => `h${String(hour).padStart(2, '0')}`;
const pad = (hour: number): string => String(hour).padStart(2, '0');

function newBuffer(): Counters {
  return { days: new Map(), routes: new Map(), peopleDays: new Map(), people: new Map(), trails: new Map(), errors: [] };
}

function bump(map: Map<string, number>, key: string, by = 1): void {
  map.set(key, (map.get(key) ?? 0) + by);
}

/**
 * Counts samples in memory. It never touches the database, and it never throws on a normal sample.
 * `swap()` hands over what was counted since the last swap, as a list of changes.
 */
export class Collector {
  /** Samples or parts of samples that were lost (a full map, or too many failed writes). */
  dropped = 0;
  /** Errors inside Drishtikit that were caught, so a request was never harmed. */
  usageErrors = 0;

  private buffer = newBuffer();
  private carry: FlushBatch = emptyBatch();
  private seq = 0;
  private readonly ring: LiveSample[] = [];
  private ringStart = 0;

  constructor(private readonly config: CollectorConfig) {}

  // ---- recording ----

  recordApi(sample: ApiSample): void {
    const { day, hour } = this.config.timeKeys.parts(sample.at);
    const g = sample.who.group;
    const key = cleanKey(`route:${sample.method.toUpperCase()} ${sample.route}`);
    const acc = this.dayAcc(g, day);
    if (!acc) {
      this.dropped++;
      return;
    }
    const ms = Math.max(0, Math.round(sample.ms));
    const bucket = bucketIndex(ms);
    acc.n++;
    acc.ms += ms;
    if (ms > acc.mx) acc.mx = ms;
    (acc.b[bucket] as number)++;
    (acc.hc[hour] as number)++;
    if (sample.status >= 500) {
      acc.e5++;
      (acc.he[hour] as number)++;
    } else if (sample.status >= 400) {
      acc.e4++;
    }
    this.countKey(acc, key);
    this.tallyMeta(acc, sample.who, sample.device, sample.version);

    const routeName = cleanKey(`${sample.method.toUpperCase()} ${sample.route}`);
    const routes = this.routeMap(g, day);
    if (routes) {
      let r = routes.get(routeName);
      if (!r && routes.size < this.config.limits.maxRoutesPerDay) {
        r = { n: 0, e4: 0, e5: 0, ms: 0, mx: 0, b: new Array<number>(BUCKET_COUNT).fill(0) };
        routes.set(routeName, r);
      }
      if (r) {
        r.n++;
        r.ms += ms;
        if (ms > r.mx) r.mx = ms;
        (r.b[bucket] as number)++;
        if (sample.status >= 500) r.e5++;
        else if (sample.status >= 400) r.e4++;
      } else {
        this.dropped++;
      }
    }

    const trail = WRITE_METHODS_ONLY.has(sample.method.toUpperCase()) ? undefined : key;
    this.touchPerson(sample.who, day, hour, sample.at, key, sample.device, sample.version, trail);

    if (sample.status >= 500) {
      this.pushError({ at: sample.at, g, where: `${sample.method.toUpperCase()} ${sample.route}`, kind: 'api', status: sample.status, v: sample.version });
    }
    this.pushLive({ at: sample.at, group: g, kind: 'api', key, status: sample.status, ms, person: sample.who.person });
  }

  /** A screen, tap, custom event, error or domain event. */
  recordUse(sample: UseSample): void {
    const { day, hour } = this.config.timeKeys.parts(sample.at);
    const g = sample.who.group;
    const key = cleanKey(sample.key);
    const acc = this.dayAcc(g, day);
    if (!acc) {
      this.dropped++;
      return;
    }
    this.countKey(acc, key);
    this.tallyMeta(acc, sample.who, sample.device, sample.version);
    for (const [name, value] of Object.entries(sample.props ?? {})) bump(acc.pr, `${name}.${value}`);
    this.touchPerson(sample.who, day, hour, sample.at, key, sample.device, sample.version, key);
    this.pushLive({ at: sample.at, group: g, kind: 'use', key, person: sample.who.person });
  }

  recordBrowserError(sample: BrowserErrorSample): void {
    this.recordUse({ at: sample.at, key: `error:${sample.where}`, who: sample.who, device: sample.device, version: sample.version });
    this.pushError({
      at: sample.at,
      g: sample.who.group,
      where: sample.where,
      kind: 'browser',
      msg: `${sample.name}: ${sample.message}`.slice(0, 120),
      v: sample.version,
    });
  }

  // ---- hand-over ----

  /** Take everything counted so far (and any batch that was given back). The collector starts empty. */
  swap(): FlushBatch {
    const batch = this.toBatch(this.buffer);
    this.buffer = newBuffer();
    const out = mergeBatch(this.carry, batch);
    this.carry = emptyBatch();
    return out;
  }

  /** Give back changes that could not be written. They join the next swap. */
  restore(batch: FlushBatch): void {
    mergeBatch(this.carry, batch);
  }

  /** What was counted and not handed over yet (a copy). The reader merges it into answers. */
  pending(): FlushBatch {
    return mergeBatch(mergeBatch(emptyBatch(), this.carry), this.toBatch(this.buffer));
  }

  /** Drop the changes that were given back, and count them as dropped. Returns how many. */
  dropCarry(): number {
    const n = batchSize(this.carry);
    this.carry = emptyBatch();
    this.dropped += n;
    return n;
  }

  /** Remove everything about one person code from memory. */
  forgetPerson(code: string): void {
    for (const [id, acc] of this.buffer.peopleDays) if (acc.p === code) this.buffer.peopleDays.delete(id);
    for (const [id, acc] of this.buffer.people) if (acc.p === code) this.buffer.people.delete(id);
    for (const [id, acc] of this.buffer.trails) if (acc.p === code) this.buffer.trails.delete(id);
    for (const name of ['people_days', 'people', 'trails'] as const) {
      this.carry[name] = this.carry[name].filter((op) => op.onInsert?.p !== code);
    }
    for (const sample of this.ring) if (sample.person === code) sample.person = undefined;
  }

  /** Samples after a sequence number, oldest first. */
  live(after = 0, limit = 200): LiveSample[] {
    const out: LiveSample[] = [];
    const n = this.ring.length;
    for (let i = 0; i < n && out.length < limit; i++) {
      const sample = this.ring[(this.ringStart + i) % n] as LiveSample;
      if (sample.seq > after) out.push(sample);
    }
    return out.map((s) => ({ ...s }));
  }

  // ---- internals ----

  private dayAcc(g: string, day: string): DayAcc | undefined {
    const id = `${g}#${day}`;
    let acc = this.buffer.days.get(id);
    if (!acc) {
      if (this.buffer.days.size >= this.config.limits.maxDayDocs) return undefined;
      acc = {
        g,
        d: day,
        n: 0,
        e4: 0,
        e5: 0,
        ms: 0,
        mx: 0,
        b: new Array<number>(BUCKET_COUNT).fill(0),
        k: new Map(),
        t: new Map(),
        dev: new Map(),
        ver: new Map(),
        pr: new Map(),
        hc: new Array<number>(24).fill(0),
        he: new Array<number>(24).fill(0),
      };
      this.buffer.days.set(id, acc);
    }
    return acc;
  }

  private routeMap(g: string, day: string): Map<string, RouteAcc> | undefined {
    const id = `${g}#${day}`;
    let map = this.buffer.routes.get(id);
    if (!map) {
      if (this.buffer.routes.size >= this.config.limits.maxDayDocs) return undefined;
      map = new Map();
      this.buffer.routes.set(id, map);
    }
    return map;
  }

  private countKey(acc: DayAcc, key: string): void {
    if (!acc.k.has(key) && acc.k.size >= this.config.limits.maxKeysPerDay) {
      this.dropped++;
      return;
    }
    bump(acc.k, key);
  }

  private tallyMeta(acc: DayAcc, who: ResolvedIdentity, device?: string, version?: string): void {
    for (const [name, value] of Object.entries(who.traits)) bump(acc.t, `${name}.${value}`);
    if (device) bump(acc.dev, device);
    if (version) bump(acc.ver, cleanKey(version));
  }

  private touchPerson(who: ResolvedIdentity, day: string, hour: number, at: number, key: string, device?: string, version?: string, trailKey?: string): void {
    const p = who.person;
    if (!p) return;
    const g = who.group;
    const id = `${day}#${g}#${p}`;
    let pd = this.buffer.peopleDays.get(id);
    if (!pd) {
      if (this.buffer.peopleDays.size >= this.config.limits.maxPeopleDays) {
        this.dropped++;
        return;
      }
      pd = { g, d: day, p, traits: who.traits, k: new Set(), h: new Set() };
      this.buffer.peopleDays.set(id, pd);
    }
    if (pd.k.size < MAX_KEYS_PER_PERSON_DAY) pd.k.add(key);
    pd.h.add(hour);
    if (Object.keys(who.traits).length > 0) pd.traits = who.traits;
    if (device) pd.dev = device;
    if (version) pd.ver = cleanKey(version);

    const pid = `${g}#${p}`;
    const person = this.buffer.people.get(pid);
    if (!person) {
      this.buffer.people.set(pid, { g, p, first: day, last: day, traits: who.traits });
    } else {
      if (day < person.first) person.first = day;
      if (day > person.last) person.last = day;
    }

    if (trailKey) {
      let trail = this.buffer.trails.get(id);
      if (!trail) {
        if (this.buffer.trails.size >= this.config.limits.maxTrails) return;
        trail = { g, d: day, p, ev: [] };
        this.buffer.trails.set(id, trail);
      }
      if (trail.ev.length < MAX_TRAIL_EVENTS) trail.ev.push({ t: at, k: trailKey });
    }
  }

  private pushError(doc: ErrorDoc): void {
    if (this.buffer.errors.length >= this.config.limits.maxErrors) {
      this.dropped++;
      return;
    }
    this.buffer.errors.push(doc);
  }

  private pushLive(sample: Omit<LiveSample, 'seq'>): void {
    const full: LiveSample = { seq: ++this.seq, ...sample };
    if (this.ring.length < this.config.liveSize) {
      this.ring.push(full);
    } else if (this.config.liveSize > 0) {
      this.ring[this.ringStart] = full;
      this.ringStart = (this.ringStart + 1) % this.config.liveSize;
    }
  }

  private toBatch(buffer: Counters): FlushBatch {
    const batch = emptyBatch();
    for (const [id, a] of buffer.days) {
      const inc: Record<string, number> = {};
      if (a.n) inc.n = a.n;
      if (a.e4) inc.e4 = a.e4;
      if (a.e5) inc.e5 = a.e5;
      if (a.ms) inc.ms = a.ms;
      a.b.forEach((v, i) => v && (inc[`b.${i}`] = v));
      a.hc.forEach((v, i) => v && (inc[`hc.${hh(i)}`] = v));
      a.he.forEach((v, i) => v && (inc[`he.${hh(i)}`] = v));
      for (const [name, map] of [['k', a.k], ['tr', a.t], ['dev', a.dev], ['ver', a.ver], ['pr', a.pr]] as const) {
        for (const [key, v] of map) inc[`${name}.${key}`] = v;
      }
      const op: UpdateOp = { id, onInsert: { g: a.g, d: a.d, t: dayToDate(a.d) }, inc };
      if (a.mx) op.max = { mx: a.mx };
      batch.usage_days.push(op);
    }
    for (const [id, routes] of buffer.routes) {
      if (routes.size === 0) continue;
      const [g, d] = splitDayId(id);
      const inc: Record<string, number> = {};
      const max: Record<string, number> = {};
      for (const [name, r] of routes) {
        inc[`r.${name}.n`] = r.n;
        if (r.e4) inc[`r.${name}.e4`] = r.e4;
        if (r.e5) inc[`r.${name}.e5`] = r.e5;
        if (r.ms) inc[`r.${name}.ms`] = r.ms;
        r.b.forEach((v, i) => v && (inc[`r.${name}.b.${i}`] = v));
        max[`r.${name}.mx`] = r.mx;
      }
      batch.route_days.push({ id, onInsert: { g, d, t: dayToDate(d) }, inc, max });
    }
    for (const [id, a] of buffer.peopleDays) {
      const set: Record<string, unknown> = {};
      if (Object.keys(a.traits).length) set.traits = a.traits;
      if (a.dev) set.dev = a.dev;
      if (a.ver) set.ver = a.ver;
      batch.people_days.push({
        id,
        onInsert: { g: a.g, d: a.d, p: a.p, t: dayToDate(a.d) },
        set,
        addToSet: { k: [...a.k], h: [...a.h].sort((x, y) => x - y).map(pad) },
      });
    }
    for (const [id, a] of buffer.people) {
      batch.people.push({
        id,
        onInsert: { g: a.g, p: a.p, traits: a.traits },
        min: { first: a.first },
        max: { last: a.last, lastAt: dayToDate(a.last) },
      });
    }
    for (const [id, a] of buffer.trails) {
      batch.trails.push({
        id,
        onInsert: { g: a.g, d: a.d, p: a.p, t: dayToDate(a.d) },
        push: { ev: { each: a.ev, slice: -MAX_TRAIL_EVENTS } },
      });
    }
    batch.errors.push(...buffer.errors);
    return batch;
  }
}

function splitDayId(id: string): [string, string] {
  const at = id.lastIndexOf('#');
  return [id.slice(0, at), id.slice(at + 1)];
}
