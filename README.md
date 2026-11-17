# Drishtikit

**Usage recording for NestJS and Angular apps.** Drishtikit records each API call, screen, tap and server action, counts them in memory, and keeps the totals in your own MongoDB. You build your own dashboard on its read API.

*Drishti* (दृष्टि) means "vision" or "insight" in Hindi and Sanskrit.

> **Status: phase 1 (usage analytics) is built and not published yet.** Version 0.1.1. The design is in [docs/PLAN.md](docs/PLAN.md).

## Phases

1. **Usage analytics** (in progress): recording, storage, read functions and `query()`.
2. **Feature flags:** the engine, the server guard and the client part.
3. **Session replay:** a masked recorder, only with consent.

## What it gives you

- **Recording on the server.** Each API call (route pattern, status, time), and the domain events that your app already publishes.
- **Recording in the app.** Screens, tapped elements that have a `data-dk` attribute, and errors, sent in small batches.
- **Storage.** Counters with latency histograms, written to MongoDB each 5 minutes, with a time limit (TTL) on raw data.
- **Read functions.** Totals, active people, top features, p50 and p95, errors, a live stream, and a flexible `query()`. They open no endpoint: your backend calls them behind your own guard, joins them with your own data, and sends the result to your own dashboard.
- **Generic.** You name the main split of the data (`group`: team, community, colony...) and declare your own fields (`traits`, for example role or plan), each with a limit on the number of values.

Drishtikit does not include a dashboard. You decide how to show the data, and who can see it.

## Principles

1. **Two lines to start.** One line in the API (`DrishtiModule.forRoot()`), one line in the app (`provideDrishti()`).
2. **Business code stays clean.** Your modules never import Drishtikit. Screens come from the router, taps from `data-dk` attributes, and server actions from your domain events.
3. **The request never waits.** The API adds to counters in memory. No database call happens inside a request.
4. **Your data stays yours.** Everything goes into your own MongoDB.
5. **Private by default.** No page text, typed text, search words, query strings, request bodies or IP addresses. People are keyed codes, not names.

## Packages

| Package | Contains |
| --- | --- |
| `@drishtikit/core` | Types, keys, latency histogram, person code, time keys, key rules, query planner. Plain TypeScript. |
| `@drishtikit/mongo` | `mongoStore()` (official `mongodb` driver) and `memoryStore()` (for tests). |
| `@drishtikit/nest` | `DrishtiModule`: middleware, collector, flush, events endpoint, domain-event bridge, `DrishtiReader`. Needs NestJS 11 with Express. |
| `@drishtikit/browser` | `createDrishti()`: taps on `data-dk` elements, errors, batches. No framework. |
| `@drishtikit/angular` | `provideDrishti()`: the browser client plus screens from the Angular router. Needs Angular 22. |

## Quick start

**1. The API.** Add the module in the start-up code. Business code does not change.

```ts
// app.module.ts
import { DrishtiModule } from '@drishtikit/nest';
import { mongoStore } from '@drishtikit/mongo';

@Module({
  imports: [
    DrishtiModule.forRoot({
      service: 'my-api',
      store: mongoStore({ uri: process.env.DRISHTI_MONGODB_URI, dbName: 'my_app_usage' }),
      key: process.env.DRISHTI_KEY, // a secret of 32 characters or more, for person codes
      identify: (req) => ({ person: req.user?.id, group: req.user?.teamId, traits: { role: req.user?.role } }),
      groupLabel: 'team',
      traits: { role: { max: 10 } }, // each trait is declared, with a limit on its values
    }),
  ],
})
export class AppModule {}

// main.ts: Drishtikit writes its counters when the app stops
app.enableShutdownHooks();
```

A Mongoose app can use its own connection: `mongoStore({ client: connection.getClient() })`.

**2. The app (Angular).**

```ts
// app.config.ts
import { provideDrishti } from '@drishtikit/angular';

provideDrishti({
  endpoint: '/api/drishti/events',
  version: '2026.11.16',
  headers: () => {
    const auth = inject(AuthService);
    return () => ({ Authorization: `Bearer ${auth.token()}` });
  },
});
```

Without Angular, use `createDrishti({ endpoint, version, headers })` from `@drishtikit/browser`, and call `dk.screen('items/:id')` yourself.

**3. Tag what you want to count.** No TypeScript change:

```html
<button data-dk="helper_add" data-dk-method="upi">Add helper</button>
```

The text of the button is never read. Extra `data-dk-<name>` values are sent as properties. Declare them on the API (`properties: { method: { max: 10 } }`), or they are dropped.

**4. Read it in your own dashboard.** Drishtikit opens no read endpoint. Your backend calls `DrishtiReader` behind your own guard:

```ts
@Controller('admin')
@UseGuards(MyAdminGuard)
export class UsageController {
  constructor(private readonly drishti: DrishtiReader) {}

  @Get('overview')
  overview(@Query('days') days = '30') {
    return this.drishti.overview({ days: Number(days) });
  }

  @Get('teams')
  async teams() {
    const usage = await this.drishti.query({ metrics: ['activePeople', 'calls'], by: ['group'], days: 30 });
    return usage.rows; // join with your own team names here
  }
}
```

Other read functions: `rules()`, `routes()`, `people()`, `health()`, `live()`, `trail()`, `setRule()`, `deleteRule()`, `forget(person)`. `query()` takes `metrics`, `by`, `where` and `days` (or `from` and `to`). A combination that is not supported throws `DrishtiQueryError` with the list of what is supported.

A full example is in [examples/nest-api](examples/nest-api). Its load test result is in [examples/nest-api/LOADTEST.md](examples/nest-api/LOADTEST.md).

## Privacy

- Not kept: page text, typed text, search words, query strings, request bodies, IP addresses, full User-Agents.
- People are codes (HMAC of the id with your key), not ids or names.
- Traits and properties are declared, each with a maximum number of values. A value that looks like an email address or a phone number is refused.
- Raw collections have a time limit (TTL). `forget(person)` erases one person.

## Develop

```sh
npm install
npm run build   # all packages
npm run lint
npm test        # needs no database: MongoDB runs in memory (mongodb-memory-server)
```

## Release

```sh
npm run pack:all   # builds everything, writes the five .tgz files to ./packed/
```

`npm publish` for `@drishtikit/angular` must run from `packages/angular/dist` (the ng-packagr output), not from `packages/angular`. The source `package.json` of angular has no entry points. `pack:all` packs angular from `dist` for the same reason. The other four packages publish from their own folders.

## Ideas we learn from

Drishtikit takes ideas from Datadog (automatic capture; the request never waits; percentiles that add up across servers) and Pendo (count first, name features later). Drishtikit is not related to these companies, and their names are their trademarks.

## Contributing

Issues and ideas are welcome. Read [CONTRIBUTING.md](CONTRIBUTING.md). To report a security problem, read [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE)
