# Drishtikit design plan

Status: planning. This plan uses short, simple sentences (ASD-STE100 style).

## 1. Summary

Drishtikit gives product analytics, feature flags and, later, session replay to NestJS and Angular apps. It keeps all data in the MongoDB of the app owner. The API adds to counters in memory and writes totals each 5 minutes, so a request never waits for Drishtikit.

## 2. Goals and limits

**Goals**

1. Show who uses the product, what they use, how often they come back, and how the API runs.
2. Turn a feature on for a group, then a percentage, then all people. Turn it off at once if there is a problem.
3. Keep business code free of analytics and flag code.
4. Keep all data in the database of the app owner.
5. Be private by default.

**Limits**

- The added time on an API call must be less than 0.1 ms.
- A Drishtikit failure must not stop or change an API call.
- It must run on the MongoDB Atlas Free plan (100 operations each second, 0.5 GB).
- It must give correct totals with one or more API replicas.

**Not now:** session replay (phase 3), custom funnels, CSV export, alerts, cross-device tracking, other frameworks.

## 3. Architecture

```
Phone (Angular app)          Server (NestJS API)              Owner (web console)
-------------------          -------------------              -------------------
Business screens             Business modules
   | data-dk tags               | domain events (no import)
   v                            v
@drishtikit/angular  ----->  @drishtikit/nest  <-------------  @drishtikit/console
 screens, clicks,   events,   middleware, counters,  console    Overview, Live, Flags,
 errors, flags      flags     flush, flag guard      API        and your own pages
                                 | flush each 5 min
                                 v
                             @drishtikit/mongo --> MongoDB (<app>_usage, flags)

@drishtikit/core: keys, latency histogram, person code, feature rules, flag engine
```

Business code never imports Drishtikit. Only the start-up code of the API and of the app does.

## 4. Usage analytics

### 4.1 Capture

- **Server.** A middleware records each API call on `res.on('finish')`: route pattern (`GET /items/:id`), status, time, tenant, person code, role, device, app version. It never reads `req.query` or `req.body`.
- **Server actions.** A bridge listens to the domain events of the app (`EventEmitter2.onAny()`). It reads only the event name, the tenant and the person.
- **App.** Screens from the router (the route pattern, not the URL). Clicks on elements with a `data-dk` attribute. Errors from the global `ErrorHandler`, cut to 80 characters, with long numbers removed.
- **Batches.** The app sends events each 30 seconds, at 20 events, or when the page hides. It uses `fetch` with `keepalive: true`, so the normal auth headers go with it. It does not retry and does not store events on the phone.
- **Identity.** The app gives `identify(req)` → `{ person, tenant, role }`. Drishtikit keeps HMAC-SHA256(key, person id), cut to 12 hex characters.

### 4.2 Counters and flush

1. Each sample goes into counters in memory: one day counter for each tenant, and one route counter for each route.
2. Each counter has calls, 4xx, 5xx, total ms and a latency histogram with 9 buckets (25, 50, 100, 200, 400, 800, 1,600, 3,200 ms and more). Histograms add together, so p50 and p95 are available for any period.
3. Sets in memory find the first visit of each person each day and each hour.
4. A ring in memory keeps the last 2,000 events for the Live page.
5. Each 5 minutes, and on `SIGTERM`, the flush swaps the maps and sends one `bulkWrite` for each collection. All writes are `$inc`, `$max`, `$min`, `$addToSet` or `$setOnInsert`, so many replicas give correct totals.
6. If a write fails, the counters go into the next flush. After 3 failures they are dropped and counted as `dropped`.
7. A rate limit (parts of 50 operations each second) keeps the flush under the Atlas Free plan limit.

### 4.3 Collections (database `<app>_usage`)

| Collection | `_id` | Holds | TTL |
| --- | --- | --- | --- |
| `usage_days` | `tenant#day` | calls, errors, ms, buckets, uses for each key, device, version, and calls, errors and people for each hour | 2 years |
| `route_days` | `tenant#day` | calls, errors, ms, max ms and buckets for each route | 90 days |
| `people_days` | `day#tenant#person` | role, device, version, the keys used that day | 120 days |
| `people` | `tenant#person` | first day, last day, role | 400 days after the last day |
| `trails` | `day#tenant#person` | the events of one person on one day (100 at most) | 14 days |
| `errors` | ObjectId | server and phone errors | 30 days |
| `feature_rules` | feature name | the keys that make the feature | none |

### 4.4 Features are rules (retroactive)

Drishtikit counts raw keys: routes, screens, clicks and domain events. A feature is a rule that groups keys, and the rules are data that you change in the console. A new rule also counts the past days that are still kept.

### 4.5 Read API

- Each console page makes one call.
- The API reads day totals by index, adds the counters in memory that are not written yet, and caches the answer for 30 seconds.
- Active people in 7 or 30 days = a count of `people` by `last`, from the index.
- Live reads only the ring in memory, each 5 seconds, with `after=<sequence>`.

## 5. Feature flags

- **Context:** person, tenant, role, device, app version, and fields that the app adds.
- **Targeting order:** kill switch → people → segments → rules → percentage → default.
- **Stable percentage:** bucket = hash(flag key + person id) mod 10,000. A person stays in the group when the percentage goes up.
- **The phone gets values, not rules:** `GET /flags` gives the values for one person.
- **Updates:** the API reloads flags each 30 seconds and at once after a change. The app asks on open, on return to the front, and each 10 minutes.
- **Kinds:** tenant feature (permanent) and release flag (with a remove-by date; the console marks old ones as stale).
- **Code:** `@Flag('key')` on a NestJS route (its guard answers `403 FEATURE_OFF`), `canMatch: [flag('key')]` and `*dkFlag="'key'"` in Angular.
- **Safety:** a fallback value in code for each flag, unit tests for each rule kind, a "Who gets it" preview before save, and a change history.
- **Standard:** names follow OpenFeature, so a provider for another flag service can come later.

## 6. Session replay (phase 3)

- A recorder (for example rrweb) keeps the page structure, changes, taps and scrolls. A player builds the session again.
- Mask all text and inputs, and block images, by default.
- Never record the screens that an app marks as private.
- Record only with consent. The first form is a "Report a problem" button that sends the last 60 seconds, which the app keeps in memory.
- Recordings go into a file store, not MongoDB, and are kept 14 days.

## 7. Console

| Page | Shows |
| --- | --- |
| Overview | Active people, calls, errors, speed, top features, busy hours |
| Live | Each event, newest first, with Pause |
| Features | People and uses for each feature, the rules editor |
| API calls | Calls, errors, p50 and p95 for each route and hour |
| People | Daily active, new people, return rate by week, device, version, role |
| Health | Server, version, errors, slow routes, database size, `dropped` |
| Flags and Segments | Each flag, its rules, its percentage, "Who gets it", stale flags |

An app adds its own pages with `provideDrishtiConsole({ pages: [...] })`. The API serves the console at `/drishti`, on the same address as the app, so a strict CSP (`script-src 'self'`) still works. A guard lets in only the owner accounts, refuses tokens older than 12 hours, and allows 60 requests each minute.

## 8. Privacy by default

- No page text, typed text, search words, query strings, request bodies or IP addresses.
- Keyed person codes, not ids or names. The key stays on the server of the app owner.
- TTL on each raw collection.
- `drishti.forget(personId)` deletes the person, day and trail documents of one person.

## 9. Repository

- `packages/` (core, nest, mongo, angular, console, replay), `examples/nest-angular/`, `docs/`.
- npm workspaces, TypeScript, Jest, Playwright, GitHub Actions on Node 22.
- Changesets for versions. Versions stay at `0.x` until the first app runs Drishtikit in production for 4 weeks.

## 10. Roadmap

1. Usage on the server (`core`, `nest`, `mongo`) and a demo app.
2. Usage in the app (`angular`).
3. Console: Overview, Live, API calls, Health, People, Features.
4. Feature flags and the Flags and Segments pages.
5. Publish `0.1` to npm.
6. Session replay (phase 3).
