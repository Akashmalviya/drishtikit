import { addBuckets, bucketIndex, emptyBuckets, percentile, toBuckets } from '../src';

describe('histogram', () => {
  it('puts a duration in the right bucket', () => {
    expect(bucketIndex(0)).toBe(0);
    expect(bucketIndex(25)).toBe(0);
    expect(bucketIndex(25.1)).toBe(1);
    expect(bucketIndex(3200)).toBe(7);
    expect(bucketIndex(3200.1)).toBe(8);
    expect(bucketIndex(99999)).toBe(8);
  });

  it('adds histograms together', () => {
    const a = emptyBuckets();
    a[1] = 2;
    const b = emptyBuckets();
    b[1] = 3;
    b[8] = 1;
    expect(addBuckets(a, b)).toEqual([0, 5, 0, 0, 0, 0, 0, 0, 1]);
  });

  it('reads buckets stored as an object', () => {
    expect(toBuckets({ '2': 4, '8': 1, '99': 5 })).toEqual([0, 0, 4, 0, 0, 0, 0, 0, 1]);
    expect(toBuckets(undefined)).toEqual(emptyBuckets());
  });

  it('gives the upper limit of the bucket that holds the percentile', () => {
    const b = emptyBuckets();
    b[0] = 50; // 50 calls up to 25 ms
    b[2] = 45; // up to 100 ms
    b[4] = 5; // up to 400 ms
    expect(percentile(b, 50)).toBe(25);
    expect(percentile(b, 51)).toBe(100);
    expect(percentile(b, 95)).toBe(100);
    expect(percentile(b, 96)).toBe(400);
    expect(percentile(b, 100)).toBe(400);
  });

  it('gives the maximum in the last bucket', () => {
    const b = emptyBuckets();
    b[8] = 10;
    expect(percentile(b, 95, 5123)).toBe(5123);
    expect(percentile(b, 95)).toBe(3200);
  });

  it('gives 0 for an empty histogram', () => {
    expect(percentile(emptyBuckets(), 95)).toBe(0);
  });

  it('gives the same answer for merged parts as for the whole', () => {
    const a = emptyBuckets();
    const b = emptyBuckets();
    a[1] = 10;
    b[6] = 10;
    const whole = addBuckets(addBuckets(emptyBuckets(), a), b);
    expect(percentile(whole, 50)).toBe(50);
    expect(percentile(whole, 95)).toBe(1600);
  });
});
