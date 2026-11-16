import {
  DEFAULT_RETENTION,
  assertKey,
  createTimeKeys,
  type DrishtiStore,
  type Retention,
} from '@drishtikit/core';

/** What an Express request looks like to Drishtikit. Only these fields are read. */
export interface DrishtiRequest {
  method: string;
  path?: string;
  ip?: string;
  headers: Record<string, string | string[] | undefined>;
  /** Set by Express after a route matched. Drishtikit reads only `route.path`. */
  route?: { path?: unknown };
  /** The signed-in user, when your auth code sets one. */
  user?: Record<string, unknown>;
  [field: string]: unknown;
}

/** What `identify` returns. Every field is optional. Drishtikit turns `person` into a code. */
export interface IdentifyResult {
  person?: unknown;
  group?: unknown;
  traits?: Record<string, unknown>;
}

/** The small part of `EventEmitter2` that the domain-event bridge needs. */
export interface EventEmitterLike {
  onAny(listener: (event: string | string[], ...values: unknown[]) => void): unknown;
}

export interface EventsOptions {
  emitter: EventEmitterLike;
  /** Key for an event name. Events with no key are ignored. The result is stored as `event:<key>`. */
  map: Record<string, string> | ((eventName: string) => string | undefined);
  /** The only fields that Drishtikit reads from an event payload: `person` and `group`. */
  identify?: (payload: unknown, eventName: string) => IdentifyResult | undefined | null;
}

export interface IngestOptions {
  /** Default `/drishti/events`. */
  path?: string;
  /** Most events in one batch. Default 50. */
  maxBatch?: number;
  /** Most bytes in one batch. Default 8192. */
  maxBytes?: number;
  /** Most batches each minute for one person or one IP address. Default 20. */
  perMinute?: number;
  /** Decorators for the endpoint, for example `[Public()]` when you have a global guard. */
  decorators?: Array<ClassDecorator | MethodDecorator>;
}

export interface FlushOptions {
  /** Default 300000 (5 minutes). */
  everyMs?: number;
  /** Operations in each part. One part is written each second. Default 50. */
  opsPerSecond?: number;
  /** Failures in a row before the counters are dropped. Default 3. */
  maxFailures?: number;
  /** Wait between parts. Default 1000. Only tests change it. */
  partDelayMs?: number;
}

export interface LimitsOptions {
  maxKeysPerDay?: number;
  maxRoutesPerDay?: number;
  maxDayDocs?: number;
  maxPeopleDays?: number;
  maxTrails?: number;
  maxErrors?: number;
}

/** The settings of `DrishtiModule.forRoot`. */
export interface DrishtiOptions {
  /** Name of this service. */
  service: string;
  env?: string;
  version?: string;
  store: DrishtiStore;
  /** Secret for person codes. 32 characters or more. */
  key: string;
  identify?: (req: DrishtiRequest) => IdentifyResult | undefined | null;
  /** What your app calls a group, for example `team`. Shown by `health()`. */
  groupLabel?: string;
  /** Traits that you declare. Each has a maximum number of different values. */
  traits?: Record<string, { max: number }>;
  /** Event properties that you declare. Each has a maximum number of different values. */
  properties?: Record<string, { max: number }>;
  /** An IANA time zone for day and hour keys. Default `UTC`. */
  timezone?: string;
  routes?: { exclude?: string[] };
  /** Header that holds the app version. Default `x-app-version`. */
  appVersionHeader?: string;
  events?: EventsOptions;
  ingest?: IngestOptions;
  keys?: { allow?: (name: string) => boolean };
  flush?: FlushOptions;
  retention?: Partial<Retention>;
  live?: { size?: number };
  cache?: { ttlMs?: number; max?: number };
  limits?: LimitsOptions;
  /** Where warnings go. Default: the Nest logger. */
  warn?: (message: string) => void;
}

/** `forRootAsync`: the same settings from a factory. The ingest endpoint is set here, because Nest needs its path at start. */
export interface DrishtiAsyncOptions {
  imports?: unknown[];
  inject?: unknown[];
  useFactory: (...args: never[]) => DrishtiOptions | Promise<DrishtiOptions>;
  /** Path and decorators of the ingest endpoint. Default path `/drishti/events`. */
  ingest?: Pick<IngestOptions, 'path' | 'decorators'>;
}

/** All settings with their defaults. */
export interface ResolvedOptions {
  service: string;
  env: string | undefined;
  version: string | undefined;
  store: DrishtiStore;
  key: string;
  identify: (req: DrishtiRequest) => IdentifyResult | undefined | null;
  groupLabel: string;
  traits: Record<string, { max: number }>;
  properties: Record<string, { max: number }>;
  timezone: string;
  excludeRoutes: string[];
  appVersionHeader: string;
  events: EventsOptions | undefined;
  ingest: { path: string; maxBatch: number; maxBytes: number; perMinute: number };
  keysAllow: ((name: string) => boolean) | undefined;
  flush: Required<FlushOptions>;
  retention: Retention;
  liveSize: number;
  cache: { ttlMs: number; max: number };
  limits: Required<LimitsOptions>;
  warn: ((message: string) => void) | undefined;
}

const FIELD_NAME = /^[A-Za-z0-9_]{1,40}$/;

function checkDeclared(label: string, declared: Record<string, { max: number }>): void {
  for (const name of Object.keys(declared)) {
    if (!FIELD_NAME.test(name)) throw new Error(`Drishtikit: ${label} name "${name}" must use letters, digits and "_" (1 to 40).`);
  }
}

/** Check the settings and fill in the defaults. Throws a clear error for a wrong setting. */
export function resolveOptions(options: DrishtiOptions): ResolvedOptions {
  if (!options || typeof options.service !== 'string' || options.service === '') {
    throw new Error('Drishtikit: "service" is required.');
  }
  if (!options.store) throw new Error('Drishtikit: "store" is required.');
  assertKey(options.key);
  const timezone = options.timezone ?? 'UTC';
  createTimeKeys(timezone); // throws when the zone is not valid
  const traits = options.traits ?? {};
  const properties = options.properties ?? {};
  checkDeclared('trait', traits);
  checkDeclared('property', properties);
  const ingestPath = `/${(options.ingest?.path ?? '/drishti/events').replace(/^\/+|\/+$/g, '')}`;
  return {
    service: options.service,
    env: options.env,
    version: options.version,
    store: options.store,
    key: options.key,
    identify: options.identify ?? (() => undefined),
    groupLabel: options.groupLabel ?? 'group',
    traits,
    properties,
    timezone,
    excludeRoutes: options.routes?.exclude ?? [],
    appVersionHeader: (options.appVersionHeader ?? 'x-app-version').toLowerCase(),
    events: options.events,
    ingest: {
      path: ingestPath,
      maxBatch: options.ingest?.maxBatch ?? 50,
      maxBytes: options.ingest?.maxBytes ?? 8192,
      perMinute: options.ingest?.perMinute ?? 20,
    },
    keysAllow: options.keys?.allow,
    flush: {
      everyMs: options.flush?.everyMs ?? 300_000,
      opsPerSecond: options.flush?.opsPerSecond ?? 50,
      maxFailures: options.flush?.maxFailures ?? 3,
      partDelayMs: options.flush?.partDelayMs ?? 1000,
    },
    retention: { ...DEFAULT_RETENTION, ...options.retention },
    liveSize: options.live?.size ?? 2000,
    cache: { ttlMs: options.cache?.ttlMs ?? 30_000, max: options.cache?.max ?? 200 },
    limits: {
      maxKeysPerDay: options.limits?.maxKeysPerDay ?? 500,
      maxRoutesPerDay: options.limits?.maxRoutesPerDay ?? 300,
      maxDayDocs: options.limits?.maxDayDocs ?? 5000,
      maxPeopleDays: options.limits?.maxPeopleDays ?? 50_000,
      maxTrails: options.limits?.maxTrails ?? 20_000,
      maxErrors: options.limits?.maxErrors ?? 1000,
    },
    warn: options.warn,
  };
}
