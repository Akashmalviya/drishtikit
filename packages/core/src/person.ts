import { createHmac } from 'node:crypto';

/** The shortest key that Drishtikit accepts for person codes. */
export const MIN_KEY_LENGTH = 32;

export function assertKey(key: unknown): asserts key is string {
  if (typeof key !== 'string' || key.length < MIN_KEY_LENGTH) {
    throw new Error(`Drishtikit: "key" is required and must have ${MIN_KEY_LENGTH} characters or more.`);
  }
}

/**
 * The code of a person: HMAC-SHA256(key, id), first 12 hex characters.
 * The id cannot be read back from the code. The key stays with the app owner.
 */
export function personCode(key: string, id: string | number): string {
  return createHmac('sha256', key).update(String(id)).digest('hex').slice(0, 12);
}
