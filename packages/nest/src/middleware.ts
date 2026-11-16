import { Inject, Injectable, type NestMiddleware } from '@nestjs/common';
import { matchesAny } from '@drishtikit/core';
import { deviceKind } from './device.js';
import type { DrishtiRequest } from './options.js';
import { DrishtiService } from './service.js';

/** The path that the module registers its middleware on (see `module.ts`). */
export const WILDCARD = '{*splat}';

interface ResponseLike {
  statusCode: number;
  on(event: 'finish', listener: () => void): unknown;
}

/**
 * Makes one sample for each API call. It reads only the method, the route pattern, the status,
 * the duration, the device kind and the app version header. It never reads the query string,
 * the body, the IP address or the full User-Agent. An error here never reaches the request.
 */
@Injectable()
export class DrishtiMiddleware implements NestMiddleware {
  constructor(@Inject(DrishtiService) private readonly service: DrishtiService) {}

  use(req: DrishtiRequest, res: ResponseLike, next: () => void): void {
    try {
      const start = process.hrtime.bigint();
      res.on('finish', () => {
        try {
          this.sample(req, res, start);
        } catch {
          this.service.collector.usageErrors++;
        }
      });
    } catch {
      this.service.collector.usageErrors++;
    }
    next();
  }

  private sample(req: DrishtiRequest, res: ResponseLike, start: bigint): void {
    const ms = Number(process.hrtime.bigint() - start) / 1e6;
    // When no route matched, Express still holds the route of our own catch-all middleware.
    const rawRoute = typeof req.route?.path === 'string' ? req.route.path : undefined;
    const matched = rawRoute !== undefined && !rawRoute.endsWith(WILDCARD) ? rawRoute : undefined;
    const route = matched ?? 'UNMATCHED';
    const { options } = this.service;
    if (matched !== undefined && matched.replace(/\/+$/, '').endsWith(options.ingest.path)) return;
    if (options.excludeRoutes.length > 0 && (matchesAny(route, options.excludeRoutes) || (req.path !== undefined && matchesAny(req.path, options.excludeRoutes)))) return;
    const versionHeader = req.headers[options.appVersionHeader];
    const version = typeof versionHeader === 'string' && versionHeader.length <= 20 ? versionHeader : undefined;
    this.service.collector.recordApi({
      at: Date.now(),
      method: req.method,
      route,
      status: res.statusCode,
      ms,
      who: this.service.identifyRequest(req),
      device: deviceKind(req.headers['user-agent']),
      version,
    });
  }
}
