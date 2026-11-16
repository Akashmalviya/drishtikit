import { assertKey, cleanKey, globToRegExp, matchesAny, matchesPattern, personCode, routeKey, rulesForKey, validateRule } from '../src';

const KEY = 'k'.repeat(32);

describe('person code', () => {
  it('is 12 hex characters and does not show the id', () => {
    const code = personCode(KEY, 'user-42');
    expect(code).toMatch(/^[0-9a-f]{12}$/);
    expect(code).not.toContain('42');
  });
  it('is stable, and differs for another id or another key', () => {
    expect(personCode(KEY, 7)).toBe(personCode(KEY, '7'));
    expect(personCode(KEY, 'a')).not.toBe(personCode(KEY, 'b'));
    expect(personCode(KEY, 'a')).not.toBe(personCode('z'.repeat(32), 'a'));
  });
  it('needs a key of 32 characters or more', () => {
    expect(() => assertKey('short')).toThrow(/32/);
    expect(() => assertKey(undefined)).toThrow(/32/);
    expect(() => assertKey(KEY)).not.toThrow();
  });
});

describe('keys', () => {
  it('changes dots and a leading dollar sign', () => {
    expect(cleanKey('route:GET /a.b/c')).toBe('route:GET /a_b/c');
    expect(cleanKey('$where')).toBe('_where');
    expect(cleanKey('a$b')).toBe('a$b');
    expect(cleanKey('a\u0000b')).toBe('ab');
    expect(cleanKey('x'.repeat(500)).length).toBe(120);
  });
  it('builds a route key', () => {
    expect(routeKey('get', '/items/:id')).toBe('route:GET /items/:id');
  });
  it('matches patterns', () => {
    expect(matchesPattern('screen:helpers/add', 'screen:helpers*')).toBe(true);
    expect(matchesPattern('screen:helper', 'screen:helpers*')).toBe(false);
    expect(matchesPattern('route:POST /helpers/x', 'route:* /helpers*')).toBe(true);
    expect(matchesPattern('tap:a.b', 'tap:a.b')).toBe(true);
    expect(matchesPattern('tap:axb', 'tap:a.b')).toBe(false); // the dot is not a wildcard
    expect(globToRegExp('a(b)*').test('a(b)zzz')).toBe(true);
    expect(matchesAny('tap:x', ['a', 'tap:*'])).toBe(true);
    expect(matchesAny('tap:x', [])).toBe(false);
  });
  it('finds the rules of a key', () => {
    const rules = [
      { name: 'Helpers', patterns: ['screen:helpers*', 'tap:helper_*'] },
      { name: 'All taps', patterns: ['tap:*'] },
    ];
    expect(rulesForKey('tap:helper_add', rules)).toEqual(['Helpers', 'All taps']);
    expect(rulesForKey('screen:home', rules)).toEqual([]);
  });
  it('checks a rule', () => {
    expect(validateRule(' Helpers ', ['a*'])).toEqual({ name: 'Helpers', patterns: ['a*'] });
    expect(() => validateRule('', ['a'])).toThrow();
    expect(() => validateRule('x', [])).toThrow();
    expect(() => validateRule('x', [''])).toThrow();
  });
});
