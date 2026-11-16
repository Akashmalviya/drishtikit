import { createDrishti, maskDigits, type DrishtiBatch, type DrishtiClient } from '../src';

type FetchMock = jest.Mock<Promise<Response>, [string, RequestInit]>;
const okFetch = (): FetchMock => jest.fn(async (_url: string, _init: RequestInit) => ({ ok: true }) as Response);
const sent = (f: FetchMock): DrishtiBatch[] => f.mock.calls.map(([, init]) => JSON.parse(init.body as string) as DrishtiBatch);
const click = (el: Element): void => void el.dispatchEvent(new MouseEvent('click', { bubbles: true }));

let client: DrishtiClient | undefined;
let beacon: jest.Mock;
beforeEach(() => {
  jest.useFakeTimers();
  document.body.innerHTML = '';
  beacon = jest.fn();
  Object.defineProperty(navigator, 'sendBeacon', { value: beacon, configurable: true });
});
afterEach(() => {
  client?.destroy();
  client = undefined;
  jest.useRealTimers();
});

describe('taps', () => {
  it('records a tap on an element with data-dk, also from a child element', async () => {
    document.body.innerHTML = '<button data-dk="helper_add" data-dk-method="upi" data-dk-source="list"><span id="inner">Add helper</span></button>';
    const f = okFetch();
    client = createDrishti({ endpoint: '/e', fetch: f, version: '2026.11.16' });
    click(document.getElementById('inner') as Element);
    await client.flush();
    const [batch] = sent(f);
    expect(batch?.v).toBe('2026.11.16');
    expect(batch?.ev).toHaveLength(1);
    expect(batch?.ev[0]).toMatchObject({ k: 'tap', n: 'helper_add', p: { method: 'upi', source: 'list' } });
    expect(typeof batch?.ev[0]?.t).toBe('number');
  });

  it('never reads the text of an element, or typed text', async () => {
    document.body.innerHTML = '<button data-dk="pay" id="b">Pay Jane Doe 4111 1111 1111 1111</button><input id="i" value="my secret password" data-dk="field">';
    const f = okFetch();
    client = createDrishti({ endpoint: '/e', fetch: f });
    click(document.getElementById('b') as Element);
    click(document.getElementById('i') as Element);
    await client.flush();
    const body = f.mock.calls.map(([, init]) => init.body).join('');
    expect(body).not.toContain('Jane');
    expect(body).not.toContain('4111');
    expect(body).not.toContain('secret');
    expect(body).toContain('pay');
    expect(body).toContain('field');
  });

  it('ignores elements without the attribute, and empty or too long names', async () => {
    document.body.innerHTML = '<button id="a">x</button><button id="b" data-dk="">x</button><button id="c" data-dk="' + 'n'.repeat(70) + '">x</button>';
    const f = okFetch();
    client = createDrishti({ endpoint: '/e', fetch: f });
    for (const id of ['a', 'b', 'c']) click(document.getElementById(id) as Element);
    await client.flush();
    expect(f).not.toHaveBeenCalled();
  });

  it('uses another attribute name', async () => {
    document.body.innerHTML = '<a data-track="go" data-track-to="home" data-dk="no">x</a>';
    const f = okFetch();
    client = createDrishti({ endpoint: '/e', fetch: f, tapAttribute: 'data-track' });
    click(document.querySelector('a') as Element);
    await client.flush();
    expect(sent(f)[0]?.ev[0]).toMatchObject({ n: 'go', p: { to: 'home' } });
  });
});

describe('screen and track', () => {
  it('records screens and custom events with primitive properties only', async () => {
    const f = okFetch();
    client = createDrishti({ endpoint: '/e', fetch: f });
    client.screen('items/:id');
    client.track('checkout_started', { method: 'upi', count: 2, ok: true, nested: { a: 1 } as never });
    client.track('');
    client.screen('   ');
    await client.flush();
    const ev = sent(f)[0]?.ev ?? [];
    expect(ev.map((e) => [e.k, e.n])).toEqual([['screen', 'items/:id'], ['custom', 'checkout_started']]);
    expect(ev[1]?.p).toEqual({ method: 'upi', count: 2, ok: true });
  });
});

describe('errors', () => {
  it('records an error with the screen, the name and a masked message', async () => {
    const f = okFetch();
    client = createDrishti({ endpoint: '/e', fetch: f });
    client.screen('items/:id');
    const error = new TypeError(`Cannot read order 1234567 of 9876543210 ${'x'.repeat(200)}`);
    window.dispatchEvent(new ErrorEvent('error', { error, message: error.message, filename: 'https://x.test/app.js?token=abc', lineno: 4 }));
    await client.flush();
    const err = sent(f)[0]?.ev.find((e) => e.k === 'error');
    expect(err?.n).toBe('TypeError');
    expect(err?.p?.s).toBe('items/:id');
    const message = err?.p?.m as string;
    expect(message.length).toBeLessThanOrEqual(80);
    expect(message.startsWith('Cannot read order # of # x')).toBe(true);
    const body = f.mock.calls[0]?.[1].body as string;
    expect(body).not.toContain('token=abc');
    expect(body).not.toContain('app.js');
    expect(body).not.toContain('9876543210');
  });

  it('records an unhandled rejection', async () => {
    const f = okFetch();
    client = createDrishti({ endpoint: '/e', fetch: f });
    const event = new Event('unhandledrejection');
    Object.defineProperty(event, 'reason', { value: new RangeError('bad 55555 value') });
    window.dispatchEvent(event);
    await client.flush();
    expect(sent(f)[0]?.ev[0]).toMatchObject({ k: 'error', n: 'RangeError', p: { s: 'unknown', m: 'bad # value' } });
  });

  it('handles a rejection with a text reason, and an error with no message', async () => {
    const f = okFetch();
    client = createDrishti({ endpoint: '/e', fetch: f });
    const a = new Event('unhandledrejection');
    Object.defineProperty(a, 'reason', { value: 'plain text 12345' });
    window.dispatchEvent(a);
    window.dispatchEvent(new ErrorEvent('error', { message: 'Script error.' }));
    await client.flush();
    const ev = sent(f)[0]?.ev ?? [];
    expect(ev[0]).toMatchObject({ n: 'Error', p: { m: 'plain text #' } });
    expect(ev[1]).toMatchObject({ n: 'Error', p: { m: 'Script error.' } });
  });

  it('does not record errors when captureErrors is false', async () => {
    const f = okFetch();
    client = createDrishti({ endpoint: '/e', fetch: f, captureErrors: false });
    window.addEventListener('error', (e) => e.preventDefault(), { once: true }); // jsdom would report it
    window.dispatchEvent(new ErrorEvent('error', { error: new Error('x'), message: 'x' }));
    await client.flush();
    expect(f).not.toHaveBeenCalled();
  });

  it('masks digits', () => {
    expect(maskDigits('a 1234 b 12345 c')).toBe('a 1234 b # c');
    expect(maskDigits('z'.repeat(100))).toHaveLength(80);
  });
});

describe('batching and sending', () => {
  it('sends after flushEveryMs', async () => {
    const f = okFetch();
    client = createDrishti({ endpoint: '/e', fetch: f, flushEveryMs: 30_000 });
    client.screen('a');
    expect(f).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(29_999);
    expect(f).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(1);
    expect(f).toHaveBeenCalledTimes(1);
    expect(client.queued).toBe(0);
  });

  it('sends at maxBatch events', async () => {
    const f = okFetch();
    client = createDrishti({ endpoint: '/e', fetch: f, maxBatch: 3 });
    client.screen('a');
    client.screen('b');
    expect(f).not.toHaveBeenCalled();
    client.screen('c');
    await Promise.resolve();
    expect(f).toHaveBeenCalledTimes(1);
    expect(sent(f)[0]?.ev).toHaveLength(3);
  });

  it('sends when the page becomes hidden, and not when it becomes visible', async () => {
    const f = okFetch();
    client = createDrishti({ endpoint: '/e', fetch: f });
    client.screen('a');
    let state: DocumentVisibilityState = 'visible';
    Object.defineProperty(document, 'visibilityState', { get: () => state, configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
    expect(f).not.toHaveBeenCalled();
    state = 'hidden';
    document.dispatchEvent(new Event('visibilitychange'));
    await Promise.resolve();
    expect(f).toHaveBeenCalledTimes(1);
  });

  it('uses fetch with keepalive, POST, JSON and the headers function (and never sendBeacon)', async () => {
    const f = okFetch();
    let token = 'one';
    client = createDrishti({ endpoint: '/api/drishti/events', fetch: f, headers: () => ({ Authorization: `Bearer ${token}` }) });
    client.screen('a');
    await client.flush();
    token = 'two';
    client.screen('b');
    await client.flush();
    const [url, init] = f.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/drishti/events');
    expect(init.method).toBe('POST');
    expect(init.keepalive).toBe(true);
    expect(init.headers).toEqual({ 'Content-Type': 'application/json', Authorization: 'Bearer one' });
    expect((f.mock.calls[1]?.[1].headers as Record<string, string>).Authorization).toBe('Bearer two');
    expect(beacon).not.toHaveBeenCalled();
  });

  it('sends without extra headers when the headers function throws', async () => {
    const f = okFetch();
    client = createDrishti({ endpoint: '/e', fetch: f, headers: () => { throw new Error('no token'); } });
    client.screen('a');
    await client.flush();
    expect(f.mock.calls[0]?.[1].headers).toEqual({ 'Content-Type': 'application/json' });
  });

  it('does not retry and does not keep events after a failed send', async () => {
    const f: FetchMock = jest.fn(async (_url: string, _init: RequestInit): Promise<Response> => { throw new TypeError('network down'); });
    client = createDrishti({ endpoint: '/e', fetch: f });
    client.screen('a');
    await expect(client.flush()).resolves.toBeUndefined();
    expect(f).toHaveBeenCalledTimes(1);
    expect(client.queued).toBe(0);
    await jest.advanceTimersByTimeAsync(120_000);
    expect(f).toHaveBeenCalledTimes(1);
  });

  it('does not store anything on the device', async () => {
    const setItem = jest.spyOn(Storage.prototype, 'setItem');
    const f = okFetch();
    client = createDrishti({ endpoint: '/e', fetch: f });
    client.screen('a');
    await client.flush();
    expect(setItem).not.toHaveBeenCalled();
    expect(document.cookie).toBe('');
    setItem.mockRestore();
  });

  it('drops the oldest events when the queue is full', async () => {
    const f = okFetch();
    client = createDrishti({ endpoint: '/e', fetch: f, maxQueue: 3, maxBatch: 100 });
    for (const n of ['a', 'b', 'c', 'd', 'e']) client.screen(n);
    expect(client.queued).toBe(3);
    await client.flush();
    expect(sent(f)[0]?.ev.map((e) => e.n)).toEqual(['c', 'd', 'e']);
  });

  it('keeps each request under about 8 KB', async () => {
    const f = okFetch();
    client = createDrishti({ endpoint: '/e', fetch: f, maxBatch: 50, maxQueue: 500 });
    for (let i = 0; i < 100; i++) client.track(`event_${i}`, { a: 'x'.repeat(40), b: 'y'.repeat(40), c: 'z'.repeat(40) });
    await client.flush();
    expect(f.mock.calls.length).toBeGreaterThan(1);
    for (const [, init] of f.mock.calls) expect((init.body as string).length).toBeLessThan(8192);
    expect(sent(f).reduce((n, b) => n + b.ev.length, 0)).toBe(100);
  });

  it('sends nothing when the queue is empty', async () => {
    const f = okFetch();
    client = createDrishti({ endpoint: '/e', fetch: f });
    await client.flush();
    expect(f).not.toHaveBeenCalled();
  });

  it('stops everything on destroy', async () => {
    document.body.innerHTML = '<button data-dk="x">x</button>';
    const f = okFetch();
    client = createDrishti({ endpoint: '/e', fetch: f });
    client.screen('a');
    client.destroy();
    window.addEventListener('error', (e) => e.preventDefault(), { once: true }); // jsdom would report it
    click(document.querySelector('button') as Element);
    window.dispatchEvent(new ErrorEvent('error', { error: new Error('x'), message: 'x' }));
    await jest.advanceTimersByTimeAsync(60_000);
    expect(f).not.toHaveBeenCalled();
    expect(client.queued).toBe(0);
  });

  it('refuses a bad attribute name', () => {
    expect(() => createDrishti({ endpoint: '/e', tapAttribute: 'a b]' })).toThrow(/tapAttribute/);
  });

  it('needs an endpoint', () => {
    expect(() => createDrishti({ endpoint: '' })).toThrow(/endpoint/);
  });
});
