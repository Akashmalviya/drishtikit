/** Shared types for Drishtikit. Plain TypeScript. No framework code. */

/** The group used when an app does not name one. */
export const DEFAULT_GROUP = '_all';

/** Name of each collection the store keeps. */
export const COLLECTIONS = ['usage_days', 'route_days', 'people_days', 'people', 'trails', 'errors'] as const;
export type CollectionName = (typeof COLLECTIONS)[number];

/** A stored document. Every document has an `_id`. */
export interface StoredDoc {
  _id: unknown;
  [field: string]: unknown;
}

/** Who did something. All fields are optional. `person` is the raw id from the app. */
export interface Identity {
  person?: string | number | null;
  group?: string | number | null;
  traits?: Record<string, unknown>;
}

/**
 * One change to one document. A store applies it as an upsert.
 * Paths use dots, for example `k.tap:add` or `hc.h07`.
 */
export interface UpdateOp {
  id: string;
  /** Fields that are set only when the document is new. */
  onInsert?: Record<string, unknown>;
  /** Fields that are always set. */
  set?: Record<string, unknown>;
  inc?: Record<string, number>;
  max?: Record<string, number | string | Date>;
  min?: Record<string, number | string | Date>;
  addToSet?: Record<string, string[]>;
  /** Push values to the end of an array and keep the last `slice` ones. */
  push?: Record<string, { each: unknown[]; slice: number }>;
}

/** An error record (a 5xx answer or a browser error). */
export interface ErrorDoc {
  at: number;
  g: string;
  where: string;
  kind: 'api' | 'browser';
  status?: number;
  msg?: string;
  v?: string;
}

/** All changes that wait to be written. */
export interface FlushBatch {
  usage_days: UpdateOp[];
  route_days: UpdateOp[];
  people_days: UpdateOp[];
  people: UpdateOp[];
  trails: UpdateOp[];
  errors: ErrorDoc[];
}

/** Days to keep each collection. */
export interface Retention {
  trailsDays: number;
  errorsDays: number;
  routeDays: number;
  peopleDays: number;
  personDays: number;
  dayDocsDays: number;
}

export const DEFAULT_RETENTION: Retention = {
  trailsDays: 14,
  errorsDays: 30,
  routeDays: 90,
  peopleDays: 120,
  personDays: 400,
  dayDocsDays: 730,
};

/** A named set of key patterns. `*` matches any characters. */
export interface KeyRule {
  name: string;
  patterns: string[];
  updatedAt?: number;
}

/** What a read asks of the store. All fields are optional; they combine with AND. */
export interface DocFilter {
  groups?: string[];
  /** First and last day (YYYY-MM-DD, both included) on the field `d`. */
  from?: string;
  to?: string;
  /** Match documents whose `k` list has a key that fits one of these patterns. */
  keys?: string[];
  /** Match one person code. */
  person?: string;
  /** For `people`: range of the first day, and the earliest last day. */
  firstFrom?: string;
  firstTo?: string;
  lastFrom?: string;
  limit?: number;
  /** For `errors`: newest first. */
  newestFirst?: boolean;
}

/** The result of `apply`. `failed` holds the changes that were not written. */
export interface ApplyResult {
  failed: FlushBatch | null;
}

export interface StoreSize {
  documents: number;
  bytes?: number;
}

/** The store behind Drishtikit. MongoDB is one store; others can come later. */
export interface DrishtiStore {
  /** Make collections and indexes. Called once at start. */
  start(retention: Retention): Promise<void>;
  /** Write a batch. Throw when nothing could be written. Return `failed` for a partial write. */
  apply(batch: FlushBatch): Promise<ApplyResult>;
  find(collection: CollectionName, filter: DocFilter): Promise<StoredDoc[]>;
  byIds(collection: CollectionName, ids: string[]): Promise<StoredDoc[]>;
  count(collection: CollectionName, filter: DocFilter): Promise<number>;
  /** Delete the people, people_days and trails documents of one person code. Returns how many. */
  forget(personCode: string): Promise<number>;
  rules(): Promise<KeyRule[]>;
  saveRule(rule: KeyRule): Promise<void>;
  removeRule(name: string): Promise<void>;
  size(): Promise<StoreSize>;
  close(): Promise<void>;
}
