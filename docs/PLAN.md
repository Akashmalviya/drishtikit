# Drishtikit design plan

Status: phase 1 (usage analytics) is built (version 0.1.0, not published). This plan uses short, simple sentences (ASD-STE100 style).

## 1. Summary

Drishtikit is a generic library for NestJS and Angular apps. It records usage, keeps it in the MongoDB of the app owner, and gives read functions. It has no dashboard and opens no read endpoint. Each app builds its own private dashboard: its backend calls the read functions, joins the result with its own business data, and sends one answer to each screen.

Phases:

1. **Usage analytics** (this phase): recording, storage, read functions and `query()`.
2. **Feature flags:** the engine, the server guard and the client part. No management pages.
3. **Session replay:** a masked recorder that works only with consent. No player pages.

## 2. Goals, limits, non-goals

**Goals**

1. Record who uses the product, what they use, how often they come back, and how the API runs.
2. Keep business code free of recording code.
3. Keep all data in the database of the app owner.
4. Be generic: the library never knows the words of an app (colony, community, team).
5. Be private by default.

**Limits**

- The added time on an API call must be less than 0.1 ms. No database call inside a request.
- A Drishtikit failure must not stop or change an API call.
- It must run on the MongoDB Atlas Free plan (100 operations each second, 0.5 GB).
- It must give correct totals with one or more API replicas.

**Non-goals:** a dashboard, management pages, custom funnels, CSV export, alerts, cross-device tracking, advertising.

## 3. Architecture

```
Browser / Ionic app                      NestJS API (of the app owner)
-------------------                      -----------------------------
Business screens                         Business modules
   | data-dk attributes                     | domain events (no import)
   v                                        v
@drishtikit/angular (thin)               @drishtikit/nest
@drishtikit/browser  -- event batches -->  middleware, ingest endpoint, collector,
 screens, taps, errors                      flush, DrishtiReader (read functions)
                                              |                      ^
                                              | flush each 5 min      | called by the app's own
                                              v                      | guarded endpoints
                                         @drishtikit/mongo --> MongoDB (<app>_usage)

@drishtikit/core: types, keys, histogram, person code, time keys, key rules, query planner
```

Business code never imports Drishtikit. Only the start-up code of the API and of the app does.

## 4. Concepts

| Concept | Meaning |
| --- | --- |
| `person` | Who did it. Required for active-people numbers. Stored only as a person code: HMAC-SHA256(key, id), first 12 hex characters. |
| `group` | The main split of the data. Optional. The app names it (`groupLabel`), for example colony, community or team. Without a group, all data is in the group `_all`. |
| `traits` | Custom fields about the person at the time of the event (for example role, plan). Each trait must be declared with `max` (the maximum number of different values). Values past `max` become `_other`. Undeclared traits are dropped, with a warning in development. Values that look like an email address or a phone number are refused. |
| key | One thing that was used. Forms: `route:GET /items/:id`, `screen:items/:id`, `tap:<name>`, `event:<name>`, `error:<where>`. |
| key rule | A named set of key patterns, for example the feature `Helpers` = `screen:helpers*`, `route:* /helpers*`, `tap:helper_*`. Rules are data. A new rule also counts the past days that are still kept. |

**Rule for app data:** traits record what is true at the time of the event (history stays correct). Current descriptive data (names, logos, counts of things) is never copied into Drishtikit. The app joins it when it reads.

## 5. Capture

### 5.1 Server: API calls

- `DrishtiModule.forRoot()` adds a middleware for all routes.
- On `res.on('finish')`, the middleware makes a sample: method + route pattern (from `req.route.path`, `UNMATCHED` when no route matched), status, duration (from `process.hrtime.bigint()`), and the result of `identify(req)`.
- It never reads `req.query` or `req.body`. It never keeps the IP address or the full User-Agent.
- Device kind from the User-Agent with simple rules (`android`, `ios`, `desktop`, `other`), cached for 500 User-Agents.
- App version from the header `x-app-version` (configurable).
- Excluded paths: the ingest path and the paths in `routes.exclude`.
- The sample goes to the collector synchronously, inside `try`/`catch`. An error never reaches the request. It adds 1 to `usage_errors`.

### 5.2 Server: domain events

- Optional. `events.emitter` is an `EventEmitter2`-like object with `onAny`.
- `events.map` gives the key for an event name (an object or a function). Events with no key are ignored.
- The bridge reads only the event name and the fields that `events.identify(event)` returns (`person`, `group`). It never keeps other fields.

### 5.3 Browser: `@drishtikit/browser` (framework-free)

```ts
const dk = createDrishti({
  endpoint: '/api/drishti/events',
  version: '2026.11.16',
  headers: () => ({ Authorization: `Bearer ${token()}` }),
  tapAttribute: 'data-dk',          // default
  flushEveryMs: 30_000, maxBatch: 20, maxQueue: 200,
  captureErrors: true,
});
dk.screen('items/:id');
dk.track('checkout_started', { method: 'upi' });   // properties: declared on the server, else dropped
```

- One `click` listener on `document` (capture phase) records the nearest element with `data-dk`. Extra `data-dk-<name>` attributes become properties. It never reads the text of an element.
- `window` `error` and `unhandledrejection` events become `error` events: the screen, the error name and the first 80 characters of the message, with each run of 5 or more digits replaced by `#`.
- It sends a batch after `flushEveryMs`, at `maxBatch` events, or on `visibilitychange` to `hidden`. It uses `fetch(endpoint, { method: 'POST', keepalive: true, headers })`. `sendBeacon` is not used, because it cannot send an `Authorization` header.
- No retry and no storage on the device. When the queue is full, the oldest event is dropped.
- Batch body: `{ "v": "<app version>", "ev": [ { "t": <epoch ms>, "k": "screen|tap|error|custom", "n": "<name>", "p": { ... } } ] }`.

### 5.4 Angular: `@drishtikit/angular`

- `provideDrishti(config)` makes the browser client and records `screen` events on each `NavigationEnd`. The screen name is the route pattern from the router config (for example `items/:id`), never the URL.
- `config.headers` is a factory that runs once in an injection context and returns a function, so the app can use its own auth service.
- Built with `ng-packagr` (Angular package format).

### 5.5 Ingest endpoint (in `@drishtikit/nest`)

- `POST <ingest.path>` (default `/drishti/events`). Sign-in is optional: the app's `identify(req)` gives the person when there is one.
- At most `maxBatch` (50) events and `maxBytes` (8 KB). At most `perMinute` (20) batches for one person or one IP address (the IP address is used only for this limit and is not kept).
- Names must match `keys.allow` when it is set. Property names must be declared in `properties`, each with `max`.
- An event time older than 15 minutes or in the future becomes the server time.
- The endpoint answers `204` at once.

## 6. Counters and flush

### 6.1 In memory

| Structure | Key | Holds |
| --- | --- | --- |
| Day counters | `group#day` | `n`, `e4`, `e5`, `ms`, `b[9]` (latency buckets), `k{key: uses}`, `tr{trait: {value: n}}`, `dev{}`, `ver{}`, and for each hour `hc{hNN}`, `he{hNN}`, `hp{hNN}` |
| Route counters | `group#day#route` | `n`, `e4`, `e5`, `ms`, `mx`, `b[9]` |
| Seen sets | `day#group#person`, `day#group#person#key`, `hour#group#person` | first visits not yet written |
| Live ring | sequence number | the last `live.size` (2,000) samples, each with a sequence number |
| Trails | `day#group#person` | the events of one person (100 a day at most) |
| Errors | none | server errors (5xx) and browser errors |

- Latency buckets: upper limits 25, 50, 100, 200, 400, 800, 1,600 and 3,200 ms, plus one bucket above 3,200 ms. Histograms add together. p50 and p95 = walk the summed buckets to 50% or 95%; the answer is the upper limit of that bucket (the last bucket gives the maximum).
- Day and hour keys use the configured IANA time zone (`timezone`, default `UTC`), with a cached `Intl.DateTimeFormat`.
- Each map has a maximum size. Samples past the maximum add 1 to `dropped`.

### 6.2 Flush

1. A timer (`flush.everyMs`, default 300,000, `unref`) starts the flush. `onApplicationShutdown` also starts it.
2. The flush swaps the maps for new empty maps. New samples never wait.
3. It writes each collection with one `bulkWrite({ ordered: false })`, in parts of `flush.opsPerSecond` (default 50) operations, one part each second.
4. Day and route documents: `updateOne({ _id }, { $inc, $max, $setOnInsert }, { upsert: true })`. Map fields use dotted paths, for example `k.tap:helper_add`. A key that contains `.` or starts with `$` is changed (`.` → `_`, `$` → `_`).
5. Person documents: `$setOnInsert` for the first visit, `$addToSet` for new keys, `$min`/`$max` for first and last day.
6. Trails: `$push` with `$each` and `$slice: -100`.
7. Errors: `insertMany`.
8. If a write fails, the flush merges the counters back for the next flush. After `flush.maxFailures` (3) failures in a row, it drops them and adds their count to `dropped`.
9. All writes add or set once. Thus, many replicas give correct totals.

## 7. Storage (`@drishtikit/mongo`)

`mongoStore({ client | uri, dbName })`. It makes the collections and the indexes on start.

| Collection | `_id` | Holds | Indexes | TTL |
| --- | --- | --- | --- | --- |
| `usage_days` | `group#YYYY-MM-DD` | g, d, the day counters (trait counters in `tr`; `t` is the TTL date) | `{d: -1}`, `{g: 1, d: -1}` | `retention.dayDocsDays` (730) |
| `route_days` | `group#YYYY-MM-DD` | g, d, r{route: counters} | `{d: -1}` | `retention.routeDays` (90) |
| `people_days` | `YYYY-MM-DD#group#person` | g, d, p, traits, dev, ver, k[] | `{g: 1, d: -1}`, `{d: -1}`, `{k: 1, d: -1}` | `retention.peopleDays` (120) |
| `people` | `group#person` | g, p, first, last, traits | `{g: 1, first: 1}`, `{g: 1, last: 1}`, `{last: 1}` | `retention.personDays` (400) after `last` |
| `trails` | `YYYY-MM-DD#group#person` | g, d, p, ev[] | `{p: 1, d: -1}` | `retention.trailsDays` (14) |
| `errors` | ObjectId | at, g, where, kind, status, msg, v | `{at: -1}` | `retention.errorsDays` (30) |
| `key_rules` | rule name | name, patterns[], updatedAt | none | none |

The store is behind the `DrishtiStore` interface in `core`, so other stores (for example ClickHouse) can come later. `memoryStore()` is for tests.

## 8. Read functions

`DrishtiReader` is a NestJS provider. It opens no endpoint. The app puts it behind its own guarded endpoints.

### 8.1 Ready functions

| Function | Gives |
| --- | --- |
| `overview({ group?, days })` | active people (today, 7 days, 30 days), calls, 4xx, 5xx, p50, p95, top key rules, busy hours (7 × 24) |
| `rules({ group?, days })` | people and uses for each key rule, with the change against the period before |
| `routes({ group?, days })` | calls, errors, p50, p95 for each route; calls for each hour of today and yesterday |
| `people({ group?, days })` | active people each day, new people each week, return rate by first week (cohorts), device, version, traits |
| `health()` | uptime, version, flush state, `dropped`, `usage_errors`, recent errors, slow routes, store size |
| `live({ after?, limit? })` | samples after a sequence number, from memory |
| `trail({ person, days })` | the events of one person (the app gives the raw id; the reader makes the code) |
| `setRule(name, patterns)` / `deleteRule(name)` | change key rules |
| `forget(person)` | delete the people, people_days and trails documents of one person |

### 8.2 `query()`

```ts
reader.query({
  metrics: ['activePeople', 'uses', 'calls', 'e5', 'p95'],
  by: ['group', 'day', 'trait:role', 'key'],
  where: { group: ['g1'], key: 'screen:items*' },
  days: 30,                    // or from / to (YYYY-MM-DD)
});
// → { rows: [ { group: 'g1', day: '2026-11-16', activePeople: 23, uses: 41 } ], fresh: true }
```

Supported combinations (others throw `DrishtiQueryError` with the list):

| Metric | Can split by |
| --- | --- |
| `calls`, `e4`, `e5`, `p50`, `p95` | `group`, `day`, `route`; `hour` for `calls` and `e5` |
| `uses` | `group`, `day`, `key`, `rule` |
| `activePeople` | `group`, `day`, `hour`, `key`, `rule`, `trait:<name>` |
| `newPeople` | `group`, `day`, `trait:<name>` |

- Each answer adds the counters in memory that the flush did not write yet (`fresh: true`).
- Each answer is cached (default 30 seconds, 200 entries).
- Active people in 7 or 30 days = a count of `people` with `last` on or after the first day, from the index.

### 8.3 How an app builds its dashboard

The backend of the app is the only reader. It calls `DrishtiReader`, reads its own data (names, logos, counts), joins them by the group id, and sends one answer to each screen:

```ts
@Get('admin/groups')
@UseGuards(MyAdminGuard)
async groups(@Query('days') days = 30) {
  const [groups, usage] = await Promise.all([
    this.myGroups.listAll(),                                                  // the app's own data
    this.drishti.query({ metrics: ['activePeople', 'calls'], by: ['group'], days: Number(days) }),
  ]);
  const byId = new Map(usage.rows.map((r) => [r.group, r]));
  return groups.map((g) => ({ name: g.name, active: byId.get(g.id)?.activePeople ?? 0 }));
}
```

## 9. Configuration reference

```ts
DrishtiModule.forRoot({
  service: 'my-api',                                   // required
  env: process.env.NODE_ENV, version: process.env.APP_VERSION,
  store: mongoStore({ uri: process.env.DRISHTI_MONGODB_URI, dbName: 'my_app_usage' }),
  key: process.env.DRISHTI_KEY,                        // required, 32 characters or more
  identify: (req) => ({ person: req.user?.id, group: req.user?.teamId, traits: { role: req.user?.role } }),
  groupLabel: 'team',
  traits: { role: { max: 10 } },
  properties: { method: { max: 10 } },
  timezone: 'Asia/Kolkata',
  routes: { exclude: ['/health'] },
  events: { emitter, map: { OrderPlaced: 'order_placed' }, identify: (e) => ({ person: e.userId, group: e.teamId }) },
  ingest: { path: '/drishti/events', maxBatch: 50, maxBytes: 8192, perMinute: 20 },
  keys: { allow: (name) => /^[a-z0-9_:/*-]{1,60}$/.test(name) },
  flush: { everyMs: 300_000, opsPerSecond: 50, maxFailures: 3 },
  retention: { trailsDays: 14, errorsDays: 30, routeDays: 90, peopleDays: 120, personDays: 400, dayDocsDays: 730 },
  live: { size: 2000 },
  cache: { ttlMs: 30_000, max: 200 },
});
```

`forRootAsync` takes the same options from a factory (for `ConfigService`).

## 10. Privacy and security

- No page text, typed text, search words, query strings, request bodies, IP addresses or full User-Agents are kept.
- Person codes, not ids or names. The key stays with the app owner.
- Declared traits and properties only, each with a maximum number of values. Values that look like an email address or a phone number are refused.
- TTL on each raw collection. `forget(person)` for erase requests.
- No read endpoint. The ingest endpoint has limits on size and rate.

## 11. Phase 2: feature flags

- **Context:** person, group, traits, device, version, and fields from the app.
- **Order:** kill switch → people → segments → rules → percentage → default.
- **Stable percentage:** bucket = FNV-1a(flag key + `:` + person id) mod 10,000.
- **Evaluation:** on the server, from memory (< 0.01 ms). The store reloads each 30 seconds and at once after a change on the same server.
- **Server:** `@Flag('key')` on a route; its guard answers `403 FEATURE_OFF`. `FlagService.isOn(key, req)` for rare cases.
- **Client:** `GET <flags.path>` gives the values for one person, never the rules. `@drishtikit/browser` keeps them and asks again on start, on `visibilitychange` to visible, and each 10 minutes. Angular: `canMatch: [flag('key')]` and `*dkFlag="'key'"`.
- **Kinds:** permanent (for example a feature that a group bought) and release (with a remove-by date; old ones are stale).
- **Safety:** a fallback value in code for each flag; a change hook so the app can write its own change history; `whoGetsIt(key, draft)` gives counts before a save.
- **Management:** `FlagAdmin` functions only (create, change, list, segments). The app builds its own pages.
- **Names:** follow OpenFeature (flag key, evaluation context, default value).

## 12. Phase 3: session replay

- Recorder in `@drishtikit/replay`, based on rrweb.
- Default: mask all text and inputs, block images and elements that have `data-dk-private`.
- Record only after consent. The first form keeps the last 60 seconds in memory and sends them only when the person presses "Report a problem".
- Optional sampling (for example 1 in 100 sessions that gave consent).
- Storage through a `ReplayStore` interface (files or object storage, not MongoDB). Recordings are kept 14 days.
- No player pages. The app builds its own player (for example with `rrweb-player`).

## 13. Tests

- `core`: unit tests for histograms, percentiles, time keys at day and hour edges in two time zones, person codes, key cleaning, trait limits, the query planner.
- `nest` + `mongo`: integration tests with `mongodb-memory-server`: flush totals, two collectors writing to the same documents, failed flush and retry, TTL and indexes, the ingest endpoint limits, `query()` combinations, memory merge.
- `browser`: tests in jsdom: taps with `data-dk`, no text recorded, batching rules, `keepalive`, error masking.
- `angular`: a build with `ng-packagr` and one TestBed test for screen events.
- Load: `examples/nest-api` with and without the middleware, 200 requests each second for 60 seconds. The p95 difference must be less than 0.1 ms.

## 14. Repository and release

- npm workspaces: `packages/core`, `packages/nest`, `packages/mongo`, `packages/browser`, `packages/angular`, `examples/nest-api`, `docs/`.
- TypeScript (strict). Node packages: CommonJS and ESM builds. Angular: `ng-packagr`.
- Jest for Node and jsdom tests. GitHub Actions: lint, test and build on Node 22.
- Changesets for versions. `0.x` until one app runs Drishtikit in production for 4 weeks.

## 15. Later, maybe

- OpenTelemetry (OTLP) export.
- A ClickHouse store for very large volumes.
- More than one group type for one person.
- Alerts (for example, "server errors went up").
- A React wrapper for `@drishtikit/browser`.

## 16. Notes from the phase 1 build

Where the build differs from the plan above, or chose where the plan was open:

1. **Hourly people** come from the list `h` in `people_days` (set with `$addToSet`), not from `hp{hNN}` counters in the day document. This keeps the count exact with many replicas.
2. **Latency buckets** are stored as an object `b.0` to `b.8`, not as an array (MongoDB cannot create an array with `$inc` on an index). Day documents also keep `mx` (the maximum), so the last bucket gives a real maximum. The counters `tr` (traits), `dev`, `ver` and `pr` (event properties) count events, not people.
3. **TTL fields.** Each raw document has a `t` date (the day at 00:00 UTC). `people` has `lastAt`. The TTL indexes use them. The trait counters are `tr`, not `t`: in 0.1.0 they shared the name `t` with the TTL date, and MongoDB refused the whole update. The memory store now refuses a change with clashing paths in the same way ("would create a conflict at").
4. **Store interface.** `DrishtiStore` takes a list of changes (`UpdateOp`: `$inc`, `$max`, `$min`, `$addToSet`, `$push`, upsert) and gives documents back. The memory store and the memory merge of the reader use the same rules as MongoDB, so both give the same answers.
5. **Memory merge.** The reader reads the store, then applies the changes that wait in the collector and in the flush that is running now. A reader that runs while a part is being written can count that part twice for a moment.
6. **Partial write.** A write that fails in the middle gives back only the changes that failed. A network error with no detail gives back the whole part, so a change can be applied twice (at least once, not exactly once).
7. **Trails** keep screens, taps, custom events, errors, domain events and API calls that are not `GET`, `HEAD` or `OPTIONS`. Browser errors keep `Name: message` (120 characters at most). API errors keep no message.
8. **`forRootAsync`** takes `ingest.path` and `ingest.decorators` as plain values, because Nest needs the path of a controller when the module is made. New option `ingest.decorators` (for example `[Public()]`) lets the endpoint pass a global guard.
9. **Per-process state.** The list of seen trait values (for `max`), the ingest rate limit and the live ring live in the memory of one server. With many servers, each applies its own limit.
10. **Query.** `where` takes `group`, `key` and `route`. `activePeople` without a split and without a key filter reads the `people` collection (`last` on or after the first day), as in section 8.2. All other `activePeople` queries read `people_days` (120 days by default). `overview().busyHours` is weekday by hour. `health().slowRoutes` looks at the last 7 days.
11. **Platform.** Express only (Fastify is not tested). NestJS 11, Angular 22, TypeScript 6.0, Node 22. The Angular package is tested with `jest-preset-angular`.
12. **Not done in this build:** a `docs/` workspace package (the folder holds plain Markdown), and phases 2 and 3. Changesets is set up (`.changeset/config.json`), but no release was made.
13. **Load test.** `examples/nest-api/LOADTEST.md` holds the numbers. With a load generator on the same laptop, p95 varies by about 0.5 ms between identical runs, so the 0.1 ms goal is also checked with a one-connection test that removes that noise (`scripts/overhead.cjs`).
