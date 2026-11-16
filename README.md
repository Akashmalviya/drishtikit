# Drishtikit

**Product analytics, feature flags and (later) session replay for NestJS and Angular apps — in your own MongoDB, with no paid service.**

*Drishti* (दृष्टि) means "vision" or "insight" in Hindi and Sanskrit.

> **Status: planning.** There is no code yet. The design is in [docs/PLAN.md](docs/PLAN.md). The first app to use Drishtikit is Parivar, a housing-society app.

## What it gives you

- **Usage analytics.** Who uses your product, which features they use, how often they come back, and how fast and how reliably your API answers.
- **Feature flags.** Turn a feature on for one group of people, then for a percentage, then for all. Turn it off at once with a kill switch.
- **A console.** A web console for the product owner, with Overview, Live, Features, API calls, People, Health, Flags and Segments. Your app can add its own pages.
- **Session replay (later).** Masked by default, and only with consent.

## Principles

1. **Two lines to start.** One line in the API (`DrishtiModule.forRoot()`), one line in the app (`provideDrishti()`).
2. **Business code stays clean.** Your modules never import Drishtikit. Screens come from the router, clicks from `data-dk` attributes in templates, and server actions from the domain events that your app already publishes.
3. **The request never waits.** The API adds to counters in memory. A flush writes totals each 5 minutes. No database call happens inside a request.
4. **Your data stays yours.** Everything goes into your own MongoDB.
5. **Private by default.** No page text, no typed text, no search words, no query strings, no request bodies, no IP addresses. People are shown as keyed codes, not names.

## Packages (planned)

| Package | Contains |
| --- | --- |
| `@drishtikit/core` | Types, keys, latency histogram, person code, feature rules, flag engine. Plain TypeScript. |
| `@drishtikit/nest` | `DrishtiModule.forRoot()`: middleware, collector, flush, events endpoint, domain-event bridge, `@Flag()` guard, console API. |
| `@drishtikit/mongo` | MongoDB store for usage data and flags. |
| `@drishtikit/angular` | `provideDrishti()`: screens, `data-dk` clicks, errors, batches, flags client, `*dkFlag`, flag route guard. |
| `@drishtikit/console` | The console pages and `provideDrishtiConsole()`. |
| `@drishtikit/replay` | Session replay (later). |

## Five-minute setup (the target)

```ts
// API: app.module.ts
DrishtiModule.forRoot({
  service: 'my-api',
  store: mongoStore({ uri: process.env.DRISHTI_MONGODB_URI }),
  key: process.env.DRISHTI_KEY,                   // secret for person codes
  owners: process.env.DRISHTI_OWNERS?.split(','),  // who can open the console
  identify: (req) => ({ person: req.user?.id, tenant: req.user?.tenantId, role: req.user?.role }),
});

// App: app.config.ts
provideDrishti({ service: 'my-app', endpoint: '/api/drishti' });
```

```html
<!-- A tagged button: no TypeScript change -->
<button data-dk="helper_add">Add helper</button>
```

## Ideas we learn from

Drishtikit takes ideas from Datadog (automatic capture; the request never waits; percentiles that add up across servers), Pendo (count first, name features later), LaunchDarkly (targeting order, segments, stable percentage rollouts) and FullStory (session replay). Drishtikit is not related to these companies, and their names are their trademarks.

## Contributing

Issues and ideas are welcome. Read [CONTRIBUTING.md](CONTRIBUTING.md). To report a security problem, read [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE)
