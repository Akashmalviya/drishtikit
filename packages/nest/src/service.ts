import { Inject, Injectable, Logger, type OnApplicationShutdown, type OnModuleInit } from '@nestjs/common';
import {
  DEFAULT_GROUP,
  ValueLimiter,
  cleanKey,
  createTimeKeys,
  emptyBatch,
  mergeBatch,
  personCode,
  type DrishtiStore,
  type FlushBatch,
  type TimeKeys,
} from '@drishtikit/core';
import { Collector, type ResolvedIdentity } from './collector.js';
import { Flusher } from './flusher.js';
import { resolveOptions, type DrishtiOptions, type IdentifyResult, type ResolvedOptions } from './options.js';
import { DRISHTI_OPTIONS } from './tokens.js';

/**
 * The heart of the module. It owns the collector, the flusher and the store.
 * Other parts (middleware, ingest endpoint, event bridge, reader) use it.
 */
@Injectable()
export class DrishtiService implements OnModuleInit, OnApplicationShutdown {
  readonly options: ResolvedOptions;
  readonly timeKeys: TimeKeys;
  readonly collector: Collector;
  readonly flusher: Flusher;
  readonly startedAt = Date.now();
  readonly propertyLimiter: ValueLimiter;
  private readonly traitLimiter: ValueLimiter;
  private readonly logger = new Logger('Drishtikit');
  private storeStart: Promise<void> | null = null;

  constructor(@Inject(DRISHTI_OPTIONS) rawOptions: DrishtiOptions) {
    this.options = resolveOptions(rawOptions);
    const dev = this.options.env !== 'production';
    const onDrop = (kind: string) => (name: string, reason: string) => {
      if (dev) this.warn(`${kind} "${name}" was ${reason === 'refused' ? 'refused (it looks like an email or a phone number)' : 'dropped (it is not declared)'}.`);
    };
    this.traitLimiter = new ValueLimiter(this.options.traits, { onDrop: onDrop('Trait') });
    this.propertyLimiter = new ValueLimiter(this.options.properties, { onDrop: onDrop('Property') });
    this.timeKeys = createTimeKeys(this.options.timezone);
    this.collector = new Collector({ timeKeys: this.timeKeys, limits: this.options.limits, liveSize: this.options.liveSize });
    this.flusher = new Flusher(this.collector, () => this.ensureStore(), this.options.flush, (m) => this.warn(m));
  }

  get store(): DrishtiStore {
    return this.options.store;
  }

  onModuleInit(): void {
    // Start in the background: a database that is down must not stop the app.
    void this.ensureStore().catch((error: unknown) => this.warn(`store did not start: ${String(error)}`));
    this.flusher.start();
  }

  async onApplicationShutdown(): Promise<void> {
    this.flusher.stop();
    try {
      await this.flusher.flush({ fast: true });
    } catch (error) {
      this.warn(`shutdown flush failed: ${String(error)}`);
    }
  }

  /** Resolves when the store is ready. Starts it again after an earlier failure. */
  ensureStore(): Promise<DrishtiStore> {
    if (!this.storeStart) {
      this.storeStart = this.options.store.start(this.options.retention).catch((error: unknown) => {
        this.storeStart = null;
        throw error;
      });
    }
    return this.storeStart.then(() => this.options.store);
  }

  /** The person code for a raw id. */
  codeFor(person: string | number): string {
    return personCode(this.options.key, person);
  }

  /** Turn what `identify` gave into a clean identity: a person code, a safe group, limited traits. */
  resolveIdentity(raw: IdentifyResult | null | undefined): ResolvedIdentity {
    const person = raw?.person;
    const hasPerson = (typeof person === 'string' && person !== '') || (typeof person === 'number' && Number.isFinite(person));
    const rawGroup = raw?.group;
    const group =
      (typeof rawGroup === 'string' && rawGroup !== '') || typeof rawGroup === 'number'
        ? cleanKey(String(rawGroup)).replace(/#/g, '_').slice(0, 60)
        : DEFAULT_GROUP;
    return {
      person: hasPerson ? this.codeFor(person as string | number) : undefined,
      group,
      traits: this.traitLimiter.clean(raw?.traits),
    };
  }

  /** Run `identify` for a request. An error in the app's function gives an empty identity. */
  identifyRequest(req: Parameters<ResolvedOptions['identify']>[0]): ResolvedIdentity {
    try {
      return this.resolveIdentity(this.options.identify(req));
    } catch {
      this.collector.usageErrors++;
      return this.resolveIdentity(undefined);
    }
  }

  /** Everything that was counted and not written yet: the collector plus the parts being written. */
  pendingBatch(): FlushBatch {
    return mergeBatch(mergeBatch(emptyBatch(), this.flusher.inflightBatch()), this.collector.pending());
  }

  warn(message: string): void {
    if (this.options.warn) this.options.warn(message);
    else this.logger.warn(message);
  }
}
