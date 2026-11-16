import type { KeyRule } from './types.js';

const MAX_KEY_LENGTH = 120;

/**
 * Make a key safe as a database field name: `.` becomes `_`, a leading `$` becomes `_`,
 * control characters are removed, and long keys are cut.
 */
export function cleanKey(key: string): string {
  // eslint-disable-next-line no-control-regex
  let out = String(key).replace(/[\u0000-\u001f]/g, '').replace(/\./g, '_');
  if (out.startsWith('$')) out = `_${out.slice(1)}`;
  return out.length > MAX_KEY_LENGTH ? out.slice(0, MAX_KEY_LENGTH) : out;
}

/** Key of an API route, for example `route:GET /items/:id`. */
export function routeKey(method: string, pattern: string): string {
  return `route:${method.toUpperCase()} ${pattern}`;
}

const regexCache = new Map<string, RegExp>();

/** A pattern as a regular expression. `*` matches any characters. The whole key must match. */
export function globToRegExp(pattern: string): RegExp {
  let re = regexCache.get(pattern);
  if (!re) {
    const source = pattern
      .split('*')
      .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
      .join('.*');
    re = new RegExp(`^${source}$`);
    if (regexCache.size > 500) regexCache.clear();
    regexCache.set(pattern, re);
  }
  return re;
}

export function matchesPattern(key: string, pattern: string): boolean {
  return globToRegExp(pattern).test(key);
}

export function matchesAny(key: string, patterns: readonly string[]): boolean {
  for (const pattern of patterns) if (matchesPattern(key, pattern)) return true;
  return false;
}

/** The rules that a key belongs to. */
export function rulesForKey(key: string, rules: readonly KeyRule[]): string[] {
  const names: string[] = [];
  for (const rule of rules) if (matchesAny(key, rule.patterns)) names.push(rule.name);
  return names;
}

/** Check a rule. Throws a clear error when the name or a pattern is not valid. */
export function validateRule(name: string, patterns: string[]): KeyRule {
  if (typeof name !== 'string' || name.trim() === '' || name.length > 60) {
    throw new Error('Drishtikit: a rule name must have 1 to 60 characters.');
  }
  if (!Array.isArray(patterns) || patterns.length === 0 || patterns.length > 50) {
    throw new Error('Drishtikit: a rule needs 1 to 50 patterns.');
  }
  for (const pattern of patterns) {
    if (typeof pattern !== 'string' || pattern === '' || pattern.length > MAX_KEY_LENGTH) {
      throw new Error('Drishtikit: each pattern must have 1 to 120 characters.');
    }
  }
  return { name: name.trim(), patterns: [...patterns] };
}
