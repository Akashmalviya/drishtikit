/** Kinds of event that the browser client sends. */
export type EventKind = 'screen' | 'tap' | 'error' | 'custom';

/** One event in a batch: time (epoch ms), kind, name and optional properties. */
export interface DrishtiEvent {
  t: number;
  k: EventKind;
  n: string;
  p?: Record<string, string | number | boolean>;
}

/** The body that the client sends to the ingest endpoint. */
export interface DrishtiBatch {
  v?: string;
  ev: DrishtiEvent[];
}

export interface DrishtiBrowserConfig {
  /** The ingest endpoint of your API, for example `/api/drishti/events`. */
  endpoint: string;
  /** Your app version. Sent with each batch. */
  version?: string;
  /** Headers for each request, for example `Authorization`. Runs for each request. */
  headers?: () => Record<string, string>;
  /** The attribute that marks an element. Default `data-dk`. Extra `<attribute>-<name>` attributes become properties. */
  tapAttribute?: string;
  /** Send after this time. Default 30000. */
  flushEveryMs?: number;
  /** Send when this many events wait. Default 20. */
  maxBatch?: number;
  /** Keep at most this many events. The oldest are dropped. Default 200. */
  maxQueue?: number;
  /** Record `error` and `unhandledrejection` events. Default true. */
  captureErrors?: boolean;
  /** Use another `fetch`. For tests. */
  fetch?: (url: string, init: RequestInit) => Promise<unknown>;
}

export interface DrishtiClient {
  /** Record a screen. Use a pattern like `items/:id`, never a real URL. */
  screen(name: string): void;
  /** Record your own event. Properties must be declared on the server, or they are dropped. */
  track(name: string, properties?: Record<string, string | number | boolean>): void;
  /** Send what waits now. */
  flush(): Promise<void>;
  /** Number of events that wait. */
  readonly queued: number;
  /** Remove all listeners and timers. */
  destroy(): void;
}

const MAX_NAME = 60;
const MAX_VALUE = 40;
const MAX_PROPS = 10;
/** The server refuses batches over 8 KB by default. Stay a little under. */
const MAX_BATCH_BYTES = 7_500;

/** Replace each run of 5 or more digits with `#` and cut to 80 characters. */
export function maskDigits(text: string, maxLength = 80): string {
  const masked = String(text).replace(/\d{5,}/g, '#');
  return masked.length > maxLength ? masked.slice(0, maxLength) : masked;
}

function cleanProps(source: Record<string, unknown> | undefined): Record<string, string | number | boolean> | undefined {
  if (!source) return undefined;
  const out: Record<string, string | number | boolean> = {};
  let count = 0;
  for (const [name, value] of Object.entries(source)) {
    if (count >= MAX_PROPS) break;
    if (typeof value === 'string') out[name] = value.slice(0, MAX_VALUE);
    else if (typeof value === 'number' || typeof value === 'boolean') out[name] = value;
    else continue;
    count++;
  }
  return count > 0 ? out : undefined;
}

function errorName(error: unknown): string {
  const raw = error && typeof error === 'object' && 'name' in error ? String((error as { name: unknown }).name) : 'Error';
  const clean = raw.replace(/[^A-Za-z0-9_]/g, '').slice(0, 40);
  return clean || 'Error';
}

function errorMessage(error: unknown, fallback = ''): string {
  if (error && typeof error === 'object' && 'message' in error) return String((error as { message: unknown }).message);
  if (typeof error === 'string') return error;
  return fallback;
}

/**
 * Create the browser client. It needs no framework.
 * - A click on an element with `data-dk` records a `tap`. The text of the element is never read.
 * - Errors are recorded with the screen, the error name and the first 80 characters of the message
 *   (runs of 5 or more digits are replaced by `#`).
 * - Events are sent in batches with `fetch` and `keepalive`. There is no retry and no storage on the device.
 */
export function createDrishti(config: DrishtiBrowserConfig): DrishtiClient {
  if (!config || typeof config.endpoint !== 'string' || config.endpoint === '') {
    throw new Error('Drishtikit: "endpoint" is required.');
  }
  const attribute = config.tapAttribute ?? 'data-dk';
  if (!/^[A-Za-z_][\w:-]*$/.test(attribute)) throw new Error('Drishtikit: "tapAttribute" is not a valid attribute name.');
  const flushEveryMs = config.flushEveryMs ?? 30_000;
  const maxBatch = config.maxBatch ?? 20;
  const maxQueue = config.maxQueue ?? 200;
  const captureErrors = config.captureErrors ?? true;
  const doc: Document | undefined = typeof document !== 'undefined' ? document : undefined;
  const win: Window | undefined = typeof window !== 'undefined' ? window : undefined;

  let queue: DrishtiEvent[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  let screenName = 'unknown';

  const push = (event: DrishtiEvent): void => {
    queue.push(event);
    if (queue.length > maxQueue) queue.shift(); // the oldest event is dropped
    if (queue.length >= maxBatch) {
      void flush();
    } else if (timer === undefined) {
      timer = setTimeout(() => void flush(), flushEveryMs);
    }
  };

  const sendOne = async (events: DrishtiEvent[]): Promise<void> => {
    const body: DrishtiBatch = { ...(config.version ? { v: config.version } : {}), ev: events };
    let extra: Record<string, string> = {};
    try {
      extra = config.headers ? config.headers() : {};
    } catch {
      extra = {};
    }
    const doFetch = config.fetch ?? (typeof fetch !== 'undefined' ? (url: string, init: RequestInit) => fetch(url, init) : undefined);
    if (!doFetch) return;
    try {
      await doFetch(config.endpoint, {
        method: 'POST',
        keepalive: true,
        headers: { 'Content-Type': 'application/json', ...extra },
        body: JSON.stringify(body),
      });
    } catch {
      // No retry and no storage. The events are lost.
    }
  };

  async function flush(): Promise<void> {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
    const sends: Promise<void>[] = [];
    while (queue.length > 0) {
      const batch: DrishtiEvent[] = [];
      let size = 40;
      while (queue.length > 0 && batch.length < maxBatch) {
        const next = queue[0] as DrishtiEvent;
        const bytes = JSON.stringify(next).length + 1;
        if (batch.length > 0 && size + bytes > MAX_BATCH_BYTES) break;
        batch.push(queue.shift() as DrishtiEvent);
        size += bytes;
      }
      sends.push(sendOne(batch));
    }
    await Promise.all(sends);
  }

  const onClick = (event: Event): void => {
    try {
      const target = event.target;
      if (!target || !(target as Element).closest) return;
      const element = (target as Element).closest(`[${attribute}]`);
      if (!element) return;
      const name = (element.getAttribute(attribute) ?? '').trim();
      if (name === '' || name.length > MAX_NAME) return;
      // Only attributes are read. The text and the value of the element are never read.
      const props: Record<string, string> = {};
      const prefix = `${attribute}-`;
      for (const attr of Array.from(element.attributes)) {
        if (attr.name.startsWith(prefix) && attr.name.length > prefix.length) props[attr.name.slice(prefix.length)] = attr.value;
      }
      const p = cleanProps(props);
      push({ t: Date.now(), k: 'tap', n: name, ...(p ? { p } : {}) });
    } catch {
      // Recording must never break the page.
    }
  };

  const recordError = (name: string, message: string): void => {
    push({ t: Date.now(), k: 'error', n: name, p: { s: screenName.slice(0, MAX_NAME), m: maskDigits(message) } });
  };
  const onError = (event: Event): void => {
    try {
      const e = event as ErrorEvent;
      recordError(errorName(e.error), errorMessage(e.error, e.message));
    } catch {
      // ignore
    }
  };
  const onRejection = (event: Event): void => {
    try {
      const reason = (event as unknown as { reason?: unknown }).reason;
      recordError(errorName(reason), errorMessage(reason));
    } catch {
      // ignore
    }
  };
  const onHidden = (): void => {
    if (doc?.visibilityState === 'hidden') void flush();
  };

  doc?.addEventListener('click', onClick, true);
  doc?.addEventListener('visibilitychange', onHidden);
  win?.addEventListener('pagehide', onHidden);
  if (captureErrors) {
    win?.addEventListener('error', onError);
    win?.addEventListener('unhandledrejection', onRejection);
  }

  return {
    screen(name: string): void {
      const clean = String(name).trim().slice(0, MAX_NAME);
      if (clean === '') return;
      screenName = clean;
      push({ t: Date.now(), k: 'screen', n: clean });
    },
    track(name: string, properties?: Record<string, string | number | boolean>): void {
      const clean = String(name).trim();
      if (clean === '' || clean.length > MAX_NAME) return;
      const p = cleanProps(properties);
      push({ t: Date.now(), k: 'custom', n: clean, ...(p ? { p } : {}) });
    },
    flush,
    get queued(): number {
      return queue.length;
    },
    destroy(): void {
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
      queue = [];
      doc?.removeEventListener('click', onClick, true);
      doc?.removeEventListener('visibilitychange', onHidden);
      win?.removeEventListener('pagehide', onHidden);
      win?.removeEventListener('error', onError);
      win?.removeEventListener('unhandledrejection', onRejection);
    },
  };
}
