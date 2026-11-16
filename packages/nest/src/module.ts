import { Module, RequestMethod, type DynamicModule, type MiddlewareConsumer, type NestModule, type Provider } from '@nestjs/common';
import { DrishtiEventsBridge } from './events-bridge.js';
import { IngestService, createIngestController } from './ingest.js';
import { DrishtiMiddleware, WILDCARD } from './middleware.js';
import type { DrishtiAsyncOptions, DrishtiOptions, IngestOptions } from './options.js';
import { DrishtiReader } from './reader.js';
import { DrishtiService } from './service.js';
import { DRISHTI_OPTIONS } from './tokens.js';

@Module({})
export class DrishtiModule implements NestModule {
  /** Add Drishtikit to the app. One line in the start-up code. */
  static forRoot(options: DrishtiOptions): DynamicModule {
    return DrishtiModule.build([{ provide: DRISHTI_OPTIONS, useValue: options }], [], options.ingest);
  }

  /** The same, with the options from a factory (for example one that reads `ConfigService`). */
  static forRootAsync(options: DrishtiAsyncOptions): DynamicModule {
    return DrishtiModule.build(
      [{ provide: DRISHTI_OPTIONS, useFactory: options.useFactory as (...args: unknown[]) => unknown, inject: (options.inject ?? []) as never[] }],
      (options.imports ?? []) as never[],
      options.ingest,
    );
  }

  private static build(optionProviders: Provider[], imports: DynamicModule['imports'], ingest?: Pick<IngestOptions, 'path' | 'decorators'>): DynamicModule {
    return {
      module: DrishtiModule,
      global: true,
      imports,
      controllers: [createIngestController(ingest?.path ?? '/drishti/events', ingest?.decorators)],
      providers: [...optionProviders, DrishtiService, IngestService, DrishtiMiddleware, DrishtiEventsBridge, DrishtiReader],
      exports: [DrishtiService, DrishtiReader],
    };
  }

  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(DrishtiMiddleware).forRoutes({ path: WILDCARD, method: RequestMethod.ALL });
  }
}
