import { applyUpdateOp, batchSize, emptyBatch, matchDoc, mergeBatch, mergeOps, splitBatch, type UpdateOp } from '../src';

describe('applyUpdateOp', () => {
  it('upserts with dotted paths', () => {
    const op: UpdateOp = {
      id: 'g#2026-11-16',
      onInsert: { g: 'g', d: '2026-11-16' },
      inc: { n: 2, 'k.tap:add': 1, 'b.3': 1 },
      max: { mx: 90 },
    };
    const doc = applyUpdateOp(undefined, op);
    expect(doc).toEqual({ _id: 'g#2026-11-16', g: 'g', d: '2026-11-16', n: 2, k: { 'tap:add': 1 }, b: { '3': 1 }, mx: 90 });
    const next = applyUpdateOp(doc, { id: op.id, onInsert: { g: 'other' }, inc: { n: 1 }, max: { mx: 50 } });
    expect(next.g).toBe('g'); // onInsert is ignored for an existing document
    expect(next.n).toBe(3);
    expect(next.mx).toBe(90);
  });

  it('handles min, max, addToSet and push', () => {
    let doc = applyUpdateOp(undefined, { id: 'p', min: { first: '2026-11-16' }, max: { last: '2026-11-16' }, addToSet: { k: ['a'] }, push: { ev: { each: [1, 2], slice: -3 } } });
    doc = applyUpdateOp(doc, { id: 'p', min: { first: '2026-11-10' }, max: { last: '2026-11-20' }, addToSet: { k: ['a', 'b'] }, push: { ev: { each: [3, 4], slice: -3 } } });
    expect(doc).toMatchObject({ first: '2026-11-10', last: '2026-11-20', k: ['a', 'b'], ev: [2, 3, 4] });
  });

  it('does not change the old document', () => {
    const old = { _id: 'x', n: 1 };
    applyUpdateOp(old, { id: 'x', inc: { n: 5 } });
    expect(old.n).toBe(1);
  });
});

describe('mergeOps and batches', () => {
  it('joins two changes of one document', () => {
    const merged = mergeOps(
      { id: 'x', inc: { n: 1 }, max: { mx: 5 }, min: { first: '2026-11-16' }, addToSet: { k: ['a'] }, push: { ev: { each: [1], slice: -2 } }, set: { t: 'a' } },
      { id: 'x', inc: { n: 2, m: 1 }, max: { mx: 3 }, min: { first: '2026-11-15' }, addToSet: { k: ['a', 'b'] }, push: { ev: { each: [2, 3], slice: -2 } }, set: { t: 'b' } },
    );
    expect(merged).toEqual({
      id: 'x',
      inc: { n: 3, m: 1 },
      max: { mx: 5 },
      min: { first: '2026-11-15' },
      addToSet: { k: ['a', 'b'] },
      push: { ev: { each: [2, 3], slice: -2 } },
      set: { t: 'b' },
    });
  });

  it('gives the same document whether ops are merged first or applied one by one', () => {
    const a: UpdateOp = { id: 'x', onInsert: { g: 'a' }, inc: { n: 1, 'k.a': 1 } };
    const b: UpdateOp = { id: 'x', inc: { n: 4, 'k.a': 2, 'k.b': 1 } };
    expect(applyUpdateOp(undefined, mergeOps(a, b))).toEqual(applyUpdateOp(applyUpdateOp(undefined, a), b));
  });

  it('merges and splits batches', () => {
    const one = emptyBatch();
    one.usage_days.push({ id: 'a', inc: { n: 1 } });
    one.errors.push({ at: 1, g: 'g', where: 'w', kind: 'api' });
    const two = emptyBatch();
    two.usage_days.push({ id: 'a', inc: { n: 2 } }, { id: 'b', inc: { n: 1 } });
    mergeBatch(one, two);
    expect(one.usage_days).toEqual([
      { id: 'a', inc: { n: 3 } },
      { id: 'b', inc: { n: 1 } },
    ]);
    expect(batchSize(one)).toBe(3);
    const parts = splitBatch(one, 2);
    expect(parts.map(batchSize)).toEqual([2, 1]);
    expect(splitBatch(emptyBatch(), 2)).toEqual([]);
  });
});

describe('matchDoc', () => {
  const doc = { _id: 'x', g: 'g1', d: '2026-11-16', p: 'abc', k: ['screen:items/:id', 'tap:add'] };
  it('filters by group, days, person and keys', () => {
    expect(matchDoc('people_days', { groups: ['g1'] }, doc)).toBe(true);
    expect(matchDoc('people_days', { groups: ['g2'] }, doc)).toBe(false);
    expect(matchDoc('people_days', { from: '2026-11-17' }, doc)).toBe(false);
    expect(matchDoc('people_days', { to: '2026-11-15' }, doc)).toBe(false);
    expect(matchDoc('people_days', { person: 'abc' }, doc)).toBe(true);
    expect(matchDoc('people_days', { keys: ['screen:items*'] }, doc)).toBe(true);
    expect(matchDoc('people_days', { keys: ['screen:other*'] }, doc)).toBe(false);
  });
  it('filters people by first and last day', () => {
    const person = { _id: 'p', g: 'g1', p: 'abc', first: '2026-11-10', last: '2026-11-16' };
    expect(matchDoc('people', { firstFrom: '2026-11-10', firstTo: '2026-11-10' }, person)).toBe(true);
    expect(matchDoc('people', { firstFrom: '2026-11-11' }, person)).toBe(false);
    expect(matchDoc('people', { lastFrom: '2026-11-17' }, person)).toBe(false);
  });
});

describe('path conflicts (the same rule as MongoDB)', () => {
  it('refuses a path set and a child path incremented', () => {
    expect(() => applyUpdateOp(undefined, { id: 'x', onInsert: { t: new Date(0) }, inc: { 't.role.admin': 1 } })).toThrow(
      "Updating the path 't.role.admin' would create a conflict at 't'",
    );
  });
  it('refuses the same path in two operators', () => {
    expect(() => applyUpdateOp(undefined, { id: 'x', set: { a: 1 }, inc: { a: 1 } })).toThrow('would create a conflict at');
  });
  it('refuses a path that is a prefix of another, in any order', () => {
    expect(() => applyUpdateOp(undefined, { id: 'x', inc: { 'k.a': 1 }, max: { k: 2 } })).toThrow("would create a conflict at 'k'");
  });
  it('allows paths that only share a first letters', () => {
    const doc = applyUpdateOp(undefined, { id: 'x', onInsert: { t: 'ttl' }, inc: { tr: 1, 'tr2.a': 1 } } as UpdateOp);
    expect(doc).toMatchObject({ t: 'ttl', tr: 1 });
  });
});
