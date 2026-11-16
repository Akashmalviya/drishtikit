export type DeviceKind = 'android' | 'ios' | 'desktop' | 'other';

const MAX_CACHE = 500;
const cache = new Map<string, DeviceKind>();

function classify(userAgent: string): DeviceKind {
  if (/android/i.test(userAgent)) return 'android';
  if (/iphone|ipad|ipod|ios/i.test(userAgent)) return 'ios';
  if (/windows|macintosh|mac os x|linux|x11|cros/i.test(userAgent)) return 'desktop';
  return 'other';
}

/**
 * Device kind from a User-Agent, with simple rules. The text is used only as a cache key in memory
 * (at most 500 entries). Only the kind is ever stored.
 */
export function deviceKind(userAgent: string | string[] | undefined): DeviceKind {
  const raw = Array.isArray(userAgent) ? userAgent[0] : userAgent;
  if (!raw) return 'other';
  const ua = raw.slice(0, 300);
  const hit = cache.get(ua);
  if (hit) return hit;
  const kind = classify(ua);
  if (cache.size >= MAX_CACHE) cache.delete(cache.keys().next().value as string);
  cache.set(ua, kind);
  return kind;
}
