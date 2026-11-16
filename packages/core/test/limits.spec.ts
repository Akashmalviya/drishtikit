import { ValueLimiter, looksPersonal, maskDigits } from '../src';

describe('looksPersonal', () => {
  it.each([
    'jane@acme.test',
    'a.b+c@x.co',
    '+91 98765 43210',
    '(555) 123-4567',
    '9876543210',
    'call 9876543210 now',
  ])('refuses %s', (value) => expect(looksPersonal(value)).toBe(true));

  it.each(['admin', 'pro plan', 'v2', 'team-7', 'web', '2026'])('allows %s', (value) => expect(looksPersonal(value)).toBe(false));
});

describe('maskDigits', () => {
  it('replaces runs of 5 or more digits', () => {
    expect(maskDigits('order 12345 failed for 9876543210')).toBe('order # failed for #');
    expect(maskDigits('code 1234 ok')).toBe('code 1234 ok');
  });
  it('cuts to 80 characters after masking', () => {
    expect(maskDigits('a'.repeat(200)).length).toBe(80);
    expect(maskDigits('1'.repeat(100))).toBe('#');
  });
});

describe('ValueLimiter', () => {
  it('drops undeclared fields and warns once', () => {
    const drops: string[] = [];
    const limiter = new ValueLimiter({ role: { max: 3 } }, { onDrop: (n, r) => drops.push(`${r}:${n}`) });
    expect(limiter.clean({ role: 'admin', secret: 'x' })).toEqual({ role: 'admin' });
    limiter.clean({ secret: 'y' });
    expect(drops).toEqual(['undeclared:secret']);
  });

  it('refuses values that look like an email or a phone number', () => {
    const drops: string[] = [];
    const limiter = new ValueLimiter({ contact: { max: 5 } }, { onDrop: (n, r) => drops.push(`${r}:${n}`) });
    expect(limiter.clean({ contact: 'jane@acme.test' })).toEqual({});
    expect(limiter.clean({ contact: '+91 98765 43210' })).toEqual({});
    expect(drops).toEqual(['refused:contact']);
  });

  it('turns values past max into _other', () => {
    const limiter = new ValueLimiter({ role: { max: 2 } });
    expect(limiter.clean({ role: 'a' })).toEqual({ role: 'a' });
    expect(limiter.clean({ role: 'b' })).toEqual({ role: 'b' });
    expect(limiter.clean({ role: 'c' })).toEqual({ role: '_other' });
    expect(limiter.clean({ role: 'a' })).toEqual({ role: 'a' });
  });

  it('keeps values safe as database keys, short, and as text', () => {
    const limiter = new ValueLimiter({ plan: { max: 9 } });
    expect(limiter.clean({ plan: 'a.b' })).toEqual({ plan: 'a_b' });
    expect(limiter.clean({ plan: 'x'.repeat(100) }).plan?.length).toBe(40);
    expect(limiter.clean({ plan: 5 })).toEqual({ plan: '5' });
    expect(limiter.clean({ plan: { nested: 1 } })).toEqual({});
    expect(limiter.clean({ plan: '' })).toEqual({});
    expect(limiter.clean(undefined)).toEqual({});
  });

  it('needs max of 1 or more', () => {
    expect(() => new ValueLimiter({ x: { max: 0 } })).toThrow(/max/);
  });
});
