import { cleanKey } from './keys.js';

/** Limit on the length of a trait or property value. */
export const MAX_VALUE_LENGTH = 40;
/** The value that replaces every value past `max`. */
export const OTHER_VALUE = '_other';

const EMAIL = /[^\s@]+@[^\s@]+\.[^\s@]+/;
const PHONE_LIKE = /^[+\d\s().-]+$/;

/** True when text looks like an email address or a phone number. Such values are never kept. */
export function looksPersonal(text: string): boolean {
  if (EMAIL.test(text)) return true;
  const digits = text.replace(/\D/g, '');
  if (digits.length >= 7 && PHONE_LIKE.test(text)) return true;
  return /\d{10,}/.test(text.replace(/[\s().-]/g, ''));
}

/** Replace each run of 5 or more digits with `#`, then cut to `maxLength` characters. */
export function maskDigits(text: string, maxLength = 80): string {
  const masked = String(text).replace(/\d{5,}/g, '#');
  return masked.length > maxLength ? masked.slice(0, maxLength) : masked;
}

export type DropReason = 'undeclared' | 'refused';

export interface LimiterOptions {
  /** Called when a value is dropped. Use it to warn in development. */
  onDrop?: (name: string, reason: DropReason) => void;
}

/**
 * Keeps declared fields only, and keeps the number of different values of each field under `max`.
 * Used for traits (about a person) and for event properties.
 * Rules:
 * 1. A field that is not declared is dropped.
 * 2. A value that looks like an email address or a phone number is dropped.
 * 3. A value past `max` different values becomes `_other`.
 */
export class ValueLimiter {
  private readonly seen = new Map<string, Set<string>>();
  private readonly warned = new Set<string>();

  constructor(
    private readonly declared: Readonly<Record<string, { max: number }>>,
    private readonly options: LimiterOptions = {},
  ) {
    for (const [name, spec] of Object.entries(declared)) {
      if (!Number.isInteger(spec.max) || spec.max < 1) {
        throw new Error(`Drishtikit: "${name}" needs "max" of 1 or more.`);
      }
      this.seen.set(name, new Set());
    }
  }

  isDeclared(name: string): boolean {
    return Object.prototype.hasOwnProperty.call(this.declared, name);
  }

  /** Clean a bag of fields. The result has string values, safe as database keys. */
  clean(input: Record<string, unknown> | undefined | null): Record<string, string> {
    const out: Record<string, string> = {};
    if (!input || typeof input !== 'object') return out;
    for (const [name, raw] of Object.entries(input)) {
      if (!this.isDeclared(name)) {
        this.drop(name, 'undeclared');
        continue;
      }
      if (raw === undefined || raw === null || typeof raw === 'object') continue;
      const text = String(raw).trim();
      if (text === '') continue;
      if (looksPersonal(text)) {
        this.drop(name, 'refused');
        continue;
      }
      out[name] = this.limit(name, cleanKey(text.slice(0, MAX_VALUE_LENGTH)));
    }
    return out;
  }

  private limit(name: string, value: string): string {
    const values = this.seen.get(name) as Set<string>;
    if (values.has(value)) return value;
    if (values.size < (this.declared[name] as { max: number }).max) {
      values.add(value);
      return value;
    }
    return OTHER_VALUE;
  }

  private drop(name: string, reason: DropReason): void {
    const id = `${reason}:${name}`;
    if (this.warned.has(id)) return;
    this.warned.add(id);
    this.options.onDrop?.(name, reason);
  }
}
