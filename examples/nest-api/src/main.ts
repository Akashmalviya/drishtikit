import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { memoryStore, mongoStore } from '@drishtikit/mongo';
import { AcmeModule } from './app.module';

/**
 * Start the demo API.
 *   PORT                  default 3400
 *   WITH_DRISHTI=0        run without Drishtikit
 *   DRISHTI_MONGODB_URI   use MongoDB; without it, usage stays in memory
 */
async function main(): Promise<void> {
  const withDrishti = process.env.WITH_DRISHTI !== '0';
  const uri = process.env.DRISHTI_MONGODB_URI;
  const store = !withDrishti ? null : uri ? mongoStore({ uri, dbName: 'acme_usage' }) : memoryStore();
  const flushEveryMs = process.env.FLUSH_EVERY_MS ? Number(process.env.FLUSH_EVERY_MS) : undefined;
  const app = await NestFactory.create(AcmeModule.register({ store, flushEveryMs }), { logger: ['error', 'warn'] });
  app.enableShutdownHooks(); // Drishtikit writes its counters on shutdown
  await app.listen(Number(process.env.PORT ?? 3400));
}

void main();
