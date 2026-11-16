# Drishtikit

**Usage recording for NestJS and Angular apps.** Drishtikit records each API call, screen, tap and server action, counts them in memory, and keeps the totals in your own MongoDB. You build your own dashboard on its read API.

*Drishti* (दृष्टि) means "vision" or "insight" in Hindi and Sanskrit.

> **Status: planning.** There is no code yet. The design is in [docs/PLAN.md](docs/PLAN.md).

## What it gives you

- **Recording on the server.** Each API call (route pattern, status, time), and the domain events that your app already publishes.
- **Recording in the app.** Screens, tapped elements that have a `data-dk` attribute, and errors, sent in small batches.
- **Storage.** Counters with latency histograms, written to MongoDB each 5 minutes, with a time limit (TTL) on raw data.
- **A read API.** Totals, active people, top keys, p50 and p95, errors and a live stream, for your own dashboards.

Drishtikit does not include a dashboard. You decide how to show the data, and who can see it.

## Principles

1. **Two lines to start.** One line in the API (`DrishtiModule.forRoot()`), one line in the app (`provideDrishti()`).
2. **Business code stays clean.** Your modules never import Drishtikit. Screens come from the router, taps from `data-dk` attributes, and server actions from your domain events.
3. **The request never waits.** The API adds to counters in memory. No database call happens inside a request.
4. **Your data stays yours.** Everything goes into your own MongoDB.
5. **Private by default.** No page text, typed text, search words, query strings, request bodies or IP addresses. People are keyed codes, not names.

## Packages (planned)

| Package | Contains |
| --- | --- |
| `@drishtikit/core` | Types, keys, latency histogram, person code, key rules. Plain TypeScript. |
| `@drishtikit/nest` | `DrishtiModule.forRoot()`: middleware, collector, flush, events endpoint, domain-event bridge, read service. |
| `@drishtikit/mongo` | The MongoDB store. |
| `@drishtikit/angular` | `provideDrishti()`: screens, `data-dk` taps, errors, batches. |

## Five-minute setup (the target)

```ts
// API: app.module.ts
DrishtiModule.forRoot({
  service: 'my-api',
  store: mongoStore({ uri: process.env.DRISHTI_MONGODB_URI }),
  key: process.env.DRISHTI_KEY, // secret for person codes
  identify: (req) => ({ person: req.user?.id, tenant: req.user?.tenantId, role: req.user?.role }),
});

// App: app.config.ts
provideDrishti({ service: 'my-app', endpoint: '/api/drishti/events' });
```

```html
<!-- A tagged button: no TypeScript change -->
<button data-dk="helper_add">Add helper</button>
```

```ts
// Your own dashboard endpoint: your guard, your UI
@Get('admin/overview')
@UseGuards(MyAdminGuard)
overview(@Query('days') days = 30) {
  return this.drishti.read.overview({ days });
}
```

## Ideas we learn from

Drishtikit takes ideas from Datadog (automatic capture; the request never waits; percentiles that add up across servers) and Pendo (count first, name features later). Drishtikit is not related to these companies, and their names are their trademarks.

## Contributing

Issues and ideas are welcome. Read [CONTRIBUTING.md](CONTRIBUTING.md). To report a security problem, read [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE)
