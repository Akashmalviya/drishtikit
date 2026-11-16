import {
  COLLECTIONS,
  applyUpdateOp,
  matchDoc,
  type ApplyResult,
  type CollectionName,
  type DocFilter,
  type DrishtiStore,
  type ErrorDoc,
  type FlushBatch,
  type KeyRule,
  type Retention,
  type StoreSize,
  type StoredDoc,
} from '@drishtikit/core';

const OP_COLLECTIONS = ['usage_days', 'route_days', 'people_days', 'people', 'trails'] as const;

/**
 * A store that keeps everything in memory. For tests and demos.
 * It follows the same rules as the MongoDB store, but it does not delete old data (no TTL).
 */
export function memoryStore(): DrishtiStore {
  const data = new Map<CollectionName, Map<string, StoredDoc>>();
  for (const name of COLLECTIONS) data.set(name, new Map());
  const rules = new Map<string, KeyRule>();
  let errorCounter = 0;
  const table = (name: CollectionName): Map<string, StoredDoc> => data.get(name) as Map<string, StoredDoc>;

  return {
    async start(_retention: Retention): Promise<void> {
      // Nothing to make.
    },

    async apply(batch: FlushBatch): Promise<ApplyResult> {
      for (const name of OP_COLLECTIONS) {
        const docs = table(name);
        for (const op of batch[name]) docs.set(op.id, applyUpdateOp(docs.get(op.id), op));
      }
      for (const error of batch.errors as ErrorDoc[]) {
        const id = `e${++errorCounter}`;
        table('errors').set(id, { _id: id, ...error });
      }
      return { failed: null };
    },

    async find(collection: CollectionName, filter: DocFilter): Promise<StoredDoc[]> {
      let docs = [...table(collection).values()].filter((doc) => matchDoc(collection, filter, doc));
      if (filter.newestFirst) docs = docs.sort((a, b) => (b.at as number) - (a.at as number));
      if (filter.limit !== undefined) docs = docs.slice(0, filter.limit);
      return structuredClone(docs);
    },

    async byIds(collection: CollectionName, ids: string[]): Promise<StoredDoc[]> {
      const docs = table(collection);
      return ids.flatMap((id) => (docs.has(id) ? [structuredClone(docs.get(id) as StoredDoc)] : []));
    },

    async count(collection: CollectionName, filter: DocFilter): Promise<number> {
      let n = 0;
      for (const doc of table(collection).values()) if (matchDoc(collection, filter, doc)) n++;
      return n;
    },

    async forget(personCode: string): Promise<number> {
      let removed = 0;
      for (const name of ['people', 'people_days', 'trails'] as const) {
        for (const [id, doc] of table(name)) {
          if (doc.p === personCode) {
            table(name).delete(id);
            removed++;
          }
        }
      }
      return removed;
    },

    async rules(): Promise<KeyRule[]> {
      return structuredClone([...rules.values()]);
    },
    async saveRule(rule: KeyRule): Promise<void> {
      rules.set(rule.name, { ...structuredClone(rule), updatedAt: Date.now() });
    },
    async removeRule(name: string): Promise<void> {
      rules.delete(name);
    },

    async size(): Promise<StoreSize> {
      let documents = 0;
      for (const name of COLLECTIONS) documents += table(name).size;
      return { documents };
    },

    async close(): Promise<void> {
      // Nothing to close.
    },
  };
}
