import { matchesAny } from './keys.js';
import type { CollectionName, DocFilter, StoredDoc } from './types.js';

/**
 * True when a document fits a filter. The memory store, the memory merge of the reader
 * and the tests use it. The MongoDB store builds the same filter as a database query.
 */
export function matchDoc(collection: CollectionName, filter: DocFilter, doc: StoredDoc): boolean {
  if (filter.groups && !filter.groups.includes(doc.g as string)) return false;
  if (filter.person !== undefined && doc.p !== filter.person) return false;
  if (collection !== 'people' && collection !== 'errors') {
    const d = doc.d as string;
    if (filter.from !== undefined && d < filter.from) return false;
    if (filter.to !== undefined && d > filter.to) return false;
  }
  if (filter.keys && filter.keys.length > 0) {
    const list = Array.isArray(doc.k) ? (doc.k as string[]) : [];
    if (!list.some((key) => matchesAny(key, filter.keys as string[]))) return false;
  }
  if (collection === 'people') {
    if (filter.firstFrom !== undefined && (doc.first as string) < filter.firstFrom) return false;
    if (filter.firstTo !== undefined && (doc.first as string) > filter.firstTo) return false;
    if (filter.lastFrom !== undefined && (doc.last as string) < filter.lastFrom) return false;
  }
  return true;
}
