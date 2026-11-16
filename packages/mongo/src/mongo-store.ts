import {
  COLLECTIONS,
  globToRegExp,
  type ApplyResult,
  type CollectionName,
  type DocFilter,
  type DrishtiStore,
  type FlushBatch,
  type KeyRule,
  type Retention,
  type StoreSize,
  type StoredDoc,
  type UpdateOp,
} from '@drishtikit/core';
import { MongoClient, type AnyBulkWriteOperation, type Db, type Document } from 'mongodb';

export interface MongoStoreOptions {
  /** A client that your app already has. For Mongoose use `connection.getClient()`. */
  client?: MongoClient;
  /** A connection string. Use this or `client`. */
  uri?: string;
  /** Database name. Default `drishti_usage`. */
  dbName?: string;
}

const OP_COLLECTIONS = ['usage_days', 'route_days', 'people_days', 'people', 'trails'] as const;
const DAY_SECONDS = 86_400;
const DUPLICATE_KEY = 11000;

/** Turn a change into a MongoDB update document. */
function toUpdate(op: UpdateOp): Document {
  const update: Document = {};
  if (op.onInsert && Object.keys(op.onInsert).length) update.$setOnInsert = op.onInsert;
  if (op.set && Object.keys(op.set).length) update.$set = op.set;
  if (op.inc && Object.keys(op.inc).length) update.$inc = op.inc;
  if (op.max && Object.keys(op.max).length) update.$max = op.max;
  if (op.min && Object.keys(op.min).length) update.$min = op.min;
  if (op.addToSet && Object.keys(op.addToSet).length) {
    update.$addToSet = Object.fromEntries(Object.entries(op.addToSet).map(([p, values]) => [p, { $each: values }]));
  }
  if (op.push && Object.keys(op.push).length) {
    update.$push = Object.fromEntries(Object.entries(op.push).map(([p, v]) => [p, { $each: v.each, $slice: v.slice }]));
  }
  return update;
}

/** Turn a filter into a MongoDB query for one collection. */
export function toMongoFilter(collection: CollectionName, filter: DocFilter): Document {
  const query: Document = {};
  if (filter.groups) query.g = { $in: filter.groups };
  if (filter.person !== undefined) query.p = filter.person;
  if (collection !== 'people' && collection !== 'errors' && (filter.from !== undefined || filter.to !== undefined)) {
    query.d = {
      ...(filter.from !== undefined ? { $gte: filter.from } : {}),
      ...(filter.to !== undefined ? { $lte: filter.to } : {}),
    };
  }
  if (filter.keys && filter.keys.length > 0) query.k = { $in: filter.keys.map((p) => globToRegExp(p)) };
  if (collection === 'people') {
    if (filter.firstFrom !== undefined || filter.firstTo !== undefined) {
      query.first = {
        ...(filter.firstFrom !== undefined ? { $gte: filter.firstFrom } : {}),
        ...(filter.firstTo !== undefined ? { $lte: filter.firstTo } : {}),
      };
    }
    if (filter.lastFrom !== undefined) query.last = { $gte: filter.lastFrom };
  }
  return query;
}

interface WriteFailure {
  index: number;
  code?: number;
}

/** Read the failed positions from a MongoDB bulk error. Returns null for any other error. */
function bulkFailures(error: unknown): WriteFailure[] | null {
  const e = error as { name?: string; writeErrors?: unknown };
  if (e?.name !== 'MongoBulkWriteError' || !e.writeErrors) return null;
  const list = Array.isArray(e.writeErrors) ? e.writeErrors : [e.writeErrors];
  return list.map((w: { index: number; code?: number }) => ({ index: w.index, code: w.code }));
}

/** The store that keeps usage in MongoDB. It uses the official `mongodb` driver. */
export function mongoStore(options: MongoStoreOptions): DrishtiStore {
  if (!options.client && !options.uri) throw new Error('Drishtikit: mongoStore needs "client" or "uri".');
  const owned = !options.client;
  const client = options.client ?? new MongoClient(options.uri as string);
  const dbName = options.dbName ?? 'drishti_usage';
  let db: Db;

  const col = (name: CollectionName | 'key_rules') => db.collection(name);

  async function ensureIndex(name: string, key: Document, extra: Document = {}): Promise<void> {
    try {
      await db.collection(name).createIndex(key, extra);
    } catch (error) {
      const code = (error as { code?: number }).code;
      // 85 and 86: the index exists with other options. Change the TTL in place.
      if ((code === 85 || code === 86) && typeof extra.expireAfterSeconds === 'number') {
        await db.command({ collMod: name, index: { keyPattern: key, expireAfterSeconds: extra.expireAfterSeconds } });
      } else {
        throw error;
      }
    }
  }

  /** Write a list of changes with one unordered bulk write. Returns the changes that failed. */
  async function writeOps(name: (typeof OP_COLLECTIONS)[number], ops: UpdateOp[]): Promise<UpdateOp[]> {
    let pending = ops.filter((op) => Object.keys(toUpdate(op)).length > 0);
    for (let attempt = 0; attempt < 3 && pending.length > 0; attempt++) {
      const requests: AnyBulkWriteOperation<Document>[] = pending.map((op) => ({
        updateOne: { filter: { _id: op.id as never }, update: toUpdate(op), upsert: true },
      }));
      try {
        await col(name).bulkWrite(requests, { ordered: false });
        return [];
      } catch (error) {
        const failures = bulkFailures(error);
        if (!failures) throw error;
        // Two servers can make the same new document at the same time. One gets a duplicate key error.
        // The change did not happen, so we try it again. The document exists now, so it works.
        const retry = failures.filter((f) => f.code === DUPLICATE_KEY).map((f) => pending[f.index] as UpdateOp);
        const hard = failures.filter((f) => f.code !== DUPLICATE_KEY).map((f) => pending[f.index] as UpdateOp);
        if (hard.length > 0) return [...hard, ...retry];
        pending = retry;
      }
    }
    return pending;
  }

  return {
    async start(retention: Retention): Promise<void> {
      if (owned) await client.connect();
      db = client.db(dbName);
      const ttl = (days: number): Document => ({ expireAfterSeconds: days * DAY_SECONDS });
      await ensureIndex('usage_days', { d: -1 });
      await ensureIndex('usage_days', { g: 1, d: -1 });
      await ensureIndex('usage_days', { t: 1 }, ttl(retention.dayDocsDays));
      await ensureIndex('route_days', { d: -1 });
      await ensureIndex('route_days', { t: 1 }, ttl(retention.routeDays));
      await ensureIndex('people_days', { g: 1, d: -1 });
      await ensureIndex('people_days', { d: -1 });
      await ensureIndex('people_days', { k: 1, d: -1 });
      await ensureIndex('people_days', { t: 1 }, ttl(retention.peopleDays));
      await ensureIndex('people', { g: 1, first: 1 });
      await ensureIndex('people', { g: 1, last: 1 });
      await ensureIndex('people', { last: 1 });
      await ensureIndex('people', { lastAt: 1 }, ttl(retention.personDays));
      await ensureIndex('trails', { p: 1, d: -1 });
      await ensureIndex('trails', { t: 1 }, ttl(retention.trailsDays));
      await ensureIndex('errors', { at: -1 }, ttl(retention.errorsDays));
    },

    async apply(batch: FlushBatch): Promise<ApplyResult> {
      const failed: FlushBatch = { usage_days: [], route_days: [], people_days: [], people: [], trails: [], errors: [] };
      let wrote = false;
      let lastError: unknown;
      for (const name of OP_COLLECTIONS) {
        const ops = batch[name];
        if (ops.length === 0) continue;
        try {
          failed[name] = await writeOps(name, ops);
          if (failed[name].length < ops.length) wrote = true;
        } catch (error) {
          lastError = error;
          failed[name] = ops;
        }
      }
      if (batch.errors.length > 0) {
        try {
          await col('errors').insertMany(
            batch.errors.map((e) => ({ ...e, at: new Date(e.at) })),
            { ordered: false },
          );
          wrote = true;
        } catch (error) {
          lastError = error;
          failed.errors = batch.errors;
        }
      }
      const anyFailed = COLLECTIONS.some((name) => failed[name].length > 0);
      if (!anyFailed) return { failed: null };
      if (!wrote && lastError) throw lastError;
      return { failed };
    },

    async find(collection: CollectionName, filter: DocFilter): Promise<StoredDoc[]> {
      let cursor = col(collection).find(toMongoFilter(collection, filter));
      if (filter.newestFirst) cursor = cursor.sort({ at: -1 });
      if (filter.limit !== undefined) cursor = cursor.limit(filter.limit);
      const docs = (await cursor.toArray()) as StoredDoc[];
      if (collection === 'errors') {
        for (const doc of docs) {
          doc._id = String(doc._id);
          doc.at = (doc.at as Date).getTime();
        }
      }
      return docs;
    },

    async byIds(collection: CollectionName, ids: string[]): Promise<StoredDoc[]> {
      if (ids.length === 0) return [];
      return (await col(collection)
        .find({ _id: { $in: ids as never[] } })
        .toArray()) as StoredDoc[];
    },

    async count(collection: CollectionName, filter: DocFilter): Promise<number> {
      return col(collection).countDocuments(toMongoFilter(collection, filter));
    },

    async forget(personCode: string): Promise<number> {
      let removed = 0;
      for (const name of ['people', 'people_days', 'trails'] as const) {
        removed += (await col(name).deleteMany({ p: personCode })).deletedCount;
      }
      return removed;
    },

    async rules(): Promise<KeyRule[]> {
      const docs = await col('key_rules').find({}).toArray();
      return docs.map((d) => ({ name: String(d._id), patterns: d.patterns as string[], updatedAt: d.updatedAt as number }));
    },
    async saveRule(rule: KeyRule): Promise<void> {
      await col('key_rules').replaceOne(
        { _id: rule.name as never },
        { name: rule.name, patterns: rule.patterns, updatedAt: Date.now() },
        { upsert: true },
      );
    },
    async removeRule(name: string): Promise<void> {
      await col('key_rules').deleteOne({ _id: name as never });
    },

    async size(): Promise<StoreSize> {
      let documents = 0;
      for (const name of COLLECTIONS) documents += await col(name).estimatedDocumentCount();
      const stats = (await db.command({ dbStats: 1 })) as { dataSize?: number; indexSize?: number };
      return { documents, bytes: (stats.dataSize ?? 0) + (stats.indexSize ?? 0) };
    },

    async close(): Promise<void> {
      if (owned) await client.close();
    },
  };
}
