import type { ErrorDoc, FlushBatch, StoredDoc, UpdateOp } from './types.js';

type Bag = Record<string, unknown>;

function getPath(doc: Bag, path: string): unknown {
  let node: unknown = doc;
  for (const part of path.split('.')) {
    if (node === null || typeof node !== 'object') return undefined;
    node = (node as Bag)[part];
  }
  return node;
}

function setPath(doc: Bag, path: string, value: unknown): void {
  const parts = path.split('.');
  let node = doc;
  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i] as string;
    const next = node[part];
    if (next === null || typeof next !== 'object') node[part] = {};
    node = node[part] as Bag;
  }
  node[parts[parts.length - 1] as string] = value;
}

function compare(a: number | string | Date, b: number | string | Date): number {
  const x = a instanceof Date ? a.getTime() : a;
  const y = b instanceof Date ? b.getTime() : b;
  return x < y ? -1 : x > y ? 1 : 0;
}

/**
 * Refuse a change that MongoDB would refuse: the same path in two operators (or twice),
 * or a path that is a prefix of another path. The message follows MongoDB.
 */
export function assertNoPathConflict(op: UpdateOp): void {
  const paths: string[] = [];
  for (const field of ['onInsert', 'set', 'inc', 'max', 'min', 'addToSet', 'push'] as const) {
    const bag = op[field];
    if (bag) paths.push(...Object.keys(bag));
  }
  for (let i = 0; i < paths.length; i++) {
    for (let j = i + 1; j < paths.length; j++) {
      const a = paths[i] as string;
      const b = paths[j] as string;
      if (a === b || a.startsWith(`${b}.`) || b.startsWith(`${a}.`)) {
        const shorter = a.length <= b.length ? a : b;
        const longer = shorter === a ? b : a;
        throw new Error(`Updating the path '${longer}' would create a conflict at '${shorter}'`);
      }
    }
  }
}

/**
 * Apply one change to a document and return the new document (an upsert).
 * The memory store and the memory merge of the reader use it. It follows the rules of MongoDB.
 */
export function applyUpdateOp(existing: StoredDoc | undefined, op: UpdateOp): StoredDoc {
  assertNoPathConflict(op);
  const isNew = existing === undefined;
  const doc = (isNew ? { _id: op.id } : structuredClone(existing)) as Bag;
  if (isNew && op.onInsert) for (const [p, v] of Object.entries(op.onInsert)) setPath(doc, p, structuredClone(v));
  if (op.set) for (const [p, v] of Object.entries(op.set)) setPath(doc, p, structuredClone(v));
  if (op.inc) for (const [p, v] of Object.entries(op.inc)) setPath(doc, p, ((getPath(doc, p) as number | undefined) ?? 0) + v);
  if (op.max) {
    for (const [p, v] of Object.entries(op.max)) {
      const current = getPath(doc, p) as number | string | Date | undefined;
      if (current === undefined || compare(v, current) > 0) setPath(doc, p, v);
    }
  }
  if (op.min) {
    for (const [p, v] of Object.entries(op.min)) {
      const current = getPath(doc, p) as number | string | Date | undefined;
      if (current === undefined || compare(v, current) < 0) setPath(doc, p, v);
    }
  }
  if (op.addToSet) {
    for (const [p, values] of Object.entries(op.addToSet)) {
      const list = (getPath(doc, p) as unknown[] | undefined) ?? [];
      for (const v of values) if (!list.includes(v)) list.push(v);
      setPath(doc, p, list);
    }
  }
  if (op.push) {
    for (const [p, spec] of Object.entries(op.push)) {
      const list = [...((getPath(doc, p) as unknown[] | undefined) ?? []), ...structuredClone(spec.each)];
      setPath(doc, p, spec.slice < 0 ? list.slice(spec.slice) : list);
    }
  }
  return doc as StoredDoc;
}

/** Join two changes of the same document into one. `later` wins when both set one field. */
export function mergeOps(earlier: UpdateOp, later: UpdateOp): UpdateOp {
  const out: UpdateOp = { id: earlier.id };
  if (earlier.onInsert || later.onInsert) out.onInsert = { ...earlier.onInsert, ...later.onInsert };
  if (earlier.set || later.set) out.set = { ...earlier.set, ...later.set };
  if (earlier.inc || later.inc) {
    out.inc = { ...earlier.inc };
    for (const [p, v] of Object.entries(later.inc ?? {})) out.inc[p] = (out.inc[p] ?? 0) + v;
  }
  for (const field of ['max', 'min'] as const) {
    if (!earlier[field] && !later[field]) continue;
    const merged: Record<string, number | string | Date> = { ...earlier[field] };
    for (const [p, v] of Object.entries(later[field] ?? {})) {
      const current = merged[p];
      if (current === undefined) merged[p] = v;
      else merged[p] = (compare(v, current) > 0) === (field === 'max') ? v : current;
    }
    out[field] = merged;
  }
  if (earlier.addToSet || later.addToSet) {
    out.addToSet = {};
    for (const source of [earlier.addToSet, later.addToSet]) {
      for (const [p, values] of Object.entries(source ?? {})) {
        const list = (out.addToSet[p] ??= []);
        for (const v of values) if (!list.includes(v)) list.push(v);
      }
    }
  }
  if (earlier.push || later.push) {
    out.push = {};
    for (const source of [earlier.push, later.push]) {
      for (const [p, spec] of Object.entries(source ?? {})) {
        const current = out.push[p];
        const each = [...(current?.each ?? []), ...spec.each];
        out.push[p] = { each: spec.slice < 0 ? each.slice(spec.slice) : each, slice: spec.slice };
      }
    }
  }
  return out;
}

export function emptyBatch(): FlushBatch {
  return { usage_days: [], route_days: [], people_days: [], people: [], trails: [], errors: [] };
}

const OP_COLLECTIONS = ['usage_days', 'route_days', 'people_days', 'people', 'trails'] as const;

/** Number of changes in a batch. */
export function batchSize(batch: FlushBatch): number {
  let n = batch.errors.length;
  for (const name of OP_COLLECTIONS) n += batch[name].length;
  return n;
}

/** Add the changes of `from` into `into`. Changes of the same document are joined. */
export function mergeBatch(into: FlushBatch, from: FlushBatch): FlushBatch {
  for (const name of OP_COLLECTIONS) {
    const index = new Map<string, number>();
    into[name].forEach((op, i) => index.set(op.id, i));
    for (const op of from[name]) {
      const at = index.get(op.id);
      if (at === undefined) {
        index.set(op.id, into[name].length);
        into[name].push(op);
      } else {
        into[name][at] = mergeOps(into[name][at] as UpdateOp, op);
      }
    }
  }
  into.errors.push(...from.errors);
  return into;
}

/** Cut a batch into parts of at most `size` changes. Order is kept. */
export function splitBatch(batch: FlushBatch, size: number): FlushBatch[] {
  const parts: FlushBatch[] = [];
  let current = emptyBatch();
  let count = 0;
  const flushPart = (): void => {
    if (count > 0) parts.push(current);
    current = emptyBatch();
    count = 0;
  };
  const add = (): void => {
    count++;
    if (count >= size) flushPart();
  };
  for (const name of OP_COLLECTIONS) {
    for (const op of batch[name]) {
      current[name].push(op);
      add();
    }
  }
  for (const doc of batch.errors as ErrorDoc[]) {
    current.errors.push(doc);
    add();
  }
  flushPart();
  return parts;
}
