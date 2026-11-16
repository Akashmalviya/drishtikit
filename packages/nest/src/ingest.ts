import { BadRequestException, Body, Controller, HttpCode, HttpException, Inject, Injectable, PayloadTooLargeException, Post, Req, type Type } from '@nestjs/common';
import { maskDigits } from '@drishtikit/core';
import { deviceKind } from './device.js';
import type { DrishtiRequest } from './options.js';
import { DrishtiService } from './service.js';

const MAX_NAME_LENGTH = 60;
const MAX_AGE_MS = 15 * 60_000;
const KINDS = new Set(['screen', 'tap', 'error', 'custom']);

interface RawEvent {
  t?: unknown;
  k?: unknown;
  n?: unknown;
  p?: unknown;
}

/** Checks and counts the batches that the browser client sends. */
@Injectable()
export class IngestService {
  private readonly windows = new Map<string, { count: number; resetAt: number }>();

  constructor(@Inject(DrishtiService) private readonly service: DrishtiService) {}

  handle(req: DrishtiRequest, body: unknown): void {
    const { ingest } = this.service.options;
    const length = Number(req.headers['content-length'] ?? 0);
    if (length > ingest.maxBytes) throw new PayloadTooLargeException('Batch is too big.');
    if (!body || typeof body !== 'object' || !Array.isArray((body as { ev?: unknown }).ev)) {
      throw new BadRequestException('Body must be { v, ev: [...] }.');
    }
    if (Buffer.byteLength(JSON.stringify(body)) > ingest.maxBytes) throw new PayloadTooLargeException('Batch is too big.');
    const batch = body as { v?: unknown; ev: unknown[] };
    if (batch.ev.length > ingest.maxBatch) throw new PayloadTooLargeException('Too many events in one batch.');

    const who = this.service.identifyRequest(req);
    this.checkRate(who.person ?? `ip:${req.ip ?? 'unknown'}`);

    const headerVersion = req.headers[this.service.options.appVersionHeader];
    const versionSource = typeof batch.v === 'string' ? batch.v : typeof headerVersion === 'string' ? headerVersion : undefined;
    const version = versionSource && versionSource.length <= 20 ? versionSource : undefined;
    const device = deviceKind(req.headers['user-agent']);
    const now = Date.now();

    for (const raw of batch.ev) {
      try {
        this.one(raw as RawEvent, who, device, version, now);
      } catch {
        this.service.collector.usageErrors++;
      }
    }
  }

  private one(ev: RawEvent, who: ReturnType<DrishtiService['identifyRequest']>, device: string, version: string | undefined, now: number): void {
    if (!ev || typeof ev !== 'object') return;
    const kind = ev.k;
    if (typeof kind !== 'string' || !KINDS.has(kind)) return;
    if (typeof ev.n !== 'string') return;
    const name = ev.n.trim();
    if (name === '' || name.length > MAX_NAME_LENGTH) return;
    const { keysAllow } = this.service.options;
    if (keysAllow && !keysAllow(name)) return;
    // An event time that is too old or in the future becomes the server time.
    const t = typeof ev.t === 'number' && Number.isFinite(ev.t) ? ev.t : now;
    const at = t > now || now - t > MAX_AGE_MS ? now : t;
    const bag = ev.p && typeof ev.p === 'object' ? (ev.p as Record<string, unknown>) : {};

    if (kind === 'error') {
      const where = typeof bag.s === 'string' && bag.s !== '' ? bag.s.slice(0, MAX_NAME_LENGTH) : 'unknown';
      const message = typeof bag.m === 'string' ? maskDigits(bag.m) : '';
      this.service.collector.recordBrowserError({ at, who, where, name: maskDigits(name, 40), message, device, version });
      return;
    }
    const props = this.service.propertyLimiter.clean(bag);
    const prefix = kind === 'custom' ? 'event' : kind;
    this.service.collector.recordUse({ at, key: `${prefix}:${name}`, who, device, version, props });
  }

  /** At most `perMinute` batches each minute for one person or one IP address. The IP address is not kept. */
  private checkRate(id: string): void {
    const now = Date.now();
    const { perMinute } = this.service.options.ingest;
    let w = this.windows.get(id);
    if (!w || w.resetAt <= now) {
      if (this.windows.size > 10_000) for (const [k, v] of this.windows) if (v.resetAt <= now) this.windows.delete(k);
      w = { count: 0, resetAt: now + 60_000 };
      this.windows.set(id, w);
    }
    w.count++;
    if (w.count > perMinute) throw new HttpException('Too many batches.', 429);
  }
}

/** Makes the controller for the ingest path. The path is set when the module is made. */
export function createIngestController(path: string, decorators: Array<ClassDecorator | MethodDecorator> = []): Type<unknown> {
  @Controller(path)
  class DrishtiIngestController {
    constructor(@Inject(IngestService) private readonly ingest: IngestService) {}

    @Post()
    @HttpCode(204)
    receive(@Req() req: DrishtiRequest, @Body() body: unknown): void {
      this.ingest.handle(req, body);
    }
  }
  for (const decorate of decorators) (decorate as ClassDecorator)(DrishtiIngestController);
  return DrishtiIngestController;
}
