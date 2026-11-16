/** Latency histogram. Nine buckets. Histograms add together, so totals stay correct across servers. */

/** Upper limit of each bucket in ms. The ninth bucket has no limit. */
export const BUCKET_LIMITS: readonly number[] = [25, 50, 100, 200, 400, 800, 1600, 3200];
export const BUCKET_COUNT = BUCKET_LIMITS.length + 1;

export function emptyBuckets(): number[] {
  return new Array<number>(BUCKET_COUNT).fill(0);
}

/** The bucket index for a duration in ms. */
export function bucketIndex(ms: number): number {
  for (let i = 0; i < BUCKET_LIMITS.length; i++) {
    if (ms <= (BUCKET_LIMITS[i] as number)) return i;
  }
  return BUCKET_LIMITS.length;
}

/** Add `source` into `target` and return `target`. */
export function addBuckets(target: number[], source: ArrayLike<number>): number[] {
  for (let i = 0; i < BUCKET_COUNT; i++) target[i] = (target[i] ?? 0) + (source[i] ?? 0);
  return target;
}

/** Read buckets from storage. A store may keep them as an array or as an object `{ "3": 5 }`. */
export function toBuckets(raw: unknown): number[] {
  const out = emptyBuckets();
  if (Array.isArray(raw)) {
    for (let i = 0; i < BUCKET_COUNT; i++) out[i] = Number(raw[i]) || 0;
  } else if (raw && typeof raw === 'object') {
    for (const [index, value] of Object.entries(raw as Record<string, unknown>)) {
      const i = Number(index);
      if (Number.isInteger(i) && i >= 0 && i < BUCKET_COUNT) out[i] = Number(value) || 0;
    }
  }
  return out;
}

/**
 * Percentile (`p` from 0 to 100) of a histogram. Walk the buckets until the sum reaches `p` percent.
 * The answer is the upper limit of that bucket. The last bucket gives `maxMs`
 * (or the highest limit when `maxMs` is not known). An empty histogram gives 0.
 */
export function percentile(buckets: ArrayLike<number>, p: number, maxMs?: number): number {
  let total = 0;
  for (let i = 0; i < BUCKET_COUNT; i++) total += buckets[i] ?? 0;
  if (total === 0) return 0;
  const target = (total * p) / 100;
  let sum = 0;
  for (let i = 0; i < BUCKET_COUNT; i++) {
    sum += buckets[i] ?? 0;
    if (sum >= target && sum > 0) {
      if (i < BUCKET_LIMITS.length) return BUCKET_LIMITS[i] as number;
      return maxMs && maxMs > 0 ? maxMs : (BUCKET_LIMITS[BUCKET_LIMITS.length - 1] as number);
    }
  }
  return maxMs ?? (BUCKET_LIMITS[BUCKET_LIMITS.length - 1] as number);
}
