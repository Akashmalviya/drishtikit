# Drishtikit design plan

Status: planning. This plan uses short, simple sentences (ASD-STE100 style).

## 1. Summary

Drishtikit records usage data for NestJS and Angular apps and keeps it in the MongoDB of the app owner. The API adds to counters in memory and writes totals each 5 minutes, so a request never waits for Drishtikit. A read API gives the totals to your own dashboards. Drishtikit has no dashboard of its own.

## 2. Goals and limits

**Goals**

1. Record who uses the product, what they use, how often they come back, and how the API runs.
2. Keep business code free of recording code.
3. Keep all data in the database of the app owner.
4. Give a simple read API, so any team can build its own dashboard.
5. Be private by default.

**Limits**

- The added time on an API call must be less than 0.1 ms.
- A Drishtikit failure must not stop or change an API call.
- It must run on the MongoDB Atlas Free plan (100 operations each second, 0.5 GB).
- It must give correct totals with one or more API replicas.

**Not in Drishtikit:** a dashboard, custom funnels, CSV export, alerts, cross-device tracking, other frameworks.

## 3. Architecture

```
Phone (Angular app)                 Server (NestJS API)
-------------------                 -------------------
Business screens                    Business modules
   | data-dk tags                      | domain events (no import)
   v                                   v
@drishtikit/angular  -- events -->  @drishtikit/nest  <-- read API --  your own dashboard
 screens, taps,                      middleware, counters,
 errors, batches                     flush, read service
                                        | flush each 5 min
                                        v
                                    @drishtikit/mongo --> MongoDB (<app>_usage)

@drishtikit/core: keys, latency histogram, person code, key rules
```

Business code never imports Drishtikit. Only the start-up code of the API and of the app does.

## 4. Capture

- **Server.** A middleware records each API call on `res.on('finish')`: route pattern (`GET /items/:id`), status, time, tenant, person code, role, device, app version. It never reads `req.query` or `req.body`.
- **Server actions.** A bridge listens to the domain events of the app (`EventEmitter2.onAny()`). It reads only the event name, the tenant and the person.
- **App.** Screens from the router (the route pattern, not the URL). Taps on elements with a `data-dk` attribute. Errors from the global `ErrorHandler`, cut to 80 characters, with long numbers removed.
- **Batches.** The app sends events each 30 seconds, at 20 events, or when the page hides. It uses `fetch` with `keepalive: true`, so the normal auth headers go with it. It does not retry and does not store events on the phone.
- **Identity.** The app gives `identify(req)` → `{ person, tenant, role }`. Drishtikit keeps HMAC-SHA256(key, person id), cut to 12 hex characters.

## 5. Counters and flush

1. Each sample goes into counters in memory: one day counter for each tenant, and one route counter for each route.
2. Each counter has calls, 4xx, 5xx, total ms and a latency histogram with 9 buckets (25, 50, 100, 200, 400, 800, 1,600, 3,200 ms and more). Histograms add together, so p50 and p95 are available for any period.
3. Sets in memory find the first visit of each person each day and each hour.
4. A ring in memory keeps the last 2,000 events for a live view.
5. Each 5 minutes, and on `SIGTERM`, the flush swaps the maps and sends one `bulkWrite` for each collection. All writes are `$inc`, `$max`, `$min`, `$addToSet` or `$setOnInsert`, so many replicas give correct totals.
6. If a write fails, the counters go into the next flush. After 3 failures they are dropped and counted as `dropped`.
7. A rate limit (parts of 50 operations each second) keeps the flush under the Atlas Free plan limit.

## 6. Collections (database `<app>_usage`)

| Collection | `_id` | Holds | TTL |
| --- | --- | --- | --- |
| `usage_days` | `tenant#day` | calls, errors, ms, buckets, uses for each key, device, version, and calls, errors and people for each hour | 2 years |
| `route_days` | `tenant#day` | calls, errors, ms, max ms and buckets for each route | 90 days |
| `people_days` | `day#tenant#person` | role, device, version, the keys used that day | 120 days |
| `people` | `tenant#person` | first day, last day, role | 400 days after the last day |
| `trails` | `day#tenant#person` | the events of one person on one day (100 at most) | 14 days |
| `errors` | ObjectId | server and phone errors | 30 days |
| `key_rules` | group name | the keys that make a group (for example a feature) | none |

**Groups are rules (retroactive).** Drishtikit counts raw keys: routes, screens, taps and domain events. A group, for example a feature, is a rule over keys. The rules are data. A new rule also counts the past days that are still kept.

## 7. Read API

The read service (`drishti.read`) gives plain objects. You put it behind your own endpoints and your own guard.

| Method | Gives |
| --- | --- |
| `overview({ tenant?, days })` | Active people (day, 7 days, 30 days), calls, errors, p50, p95, top groups, busy hours |
| `groups({ tenant?, days })` | People and uses for each group, with the trend |
| `routes({ tenant?, days })` | Calls, errors, p50 and p95 for each route, and calls for each hour |
| `people({ tenant?, days })` | Daily active, new people, return rate by week, device, version, role |
| `health()` | Uptime, version, recent errors, slow routes, database size, `dropped` |
| `live({ after })` | The events after a sequence number, from memory |
| `trail({ personCode, days })` | The events of one person (for support) |

- It reads day totals by index and adds the counters in memory that are not written yet.
- It caches each answer for 30 seconds.
- Active people in 7 or 30 days = a count of `people` by `last`, from the index.

## 8. Privacy by default

- No page text, typed text, search words, query strings, request bodies or IP addresses.
- Keyed person codes, not ids or names. The key stays on the server of the app owner.
- TTL on each raw collection.
- `drishti.forget(personId)` deletes the person, day and trail documents of one person.

## 9. Repository

- `packages/` (core, nest, mongo, angular), `examples/nest-angular/`, `docs/`.
- npm workspaces, TypeScript, Jest, GitHub Actions on Node 22.
- Changesets for versions. Versions stay at `0.x` until the first app runs Drishtikit in production for 4 weeks.

## 10. Roadmap

1. Recording on the server (`core`, `nest`, `mongo`) and a small example app.
2. Recording in the app (`angular`).
3. The read service.
4. Publish `0.1` to npm.
5. Later, maybe: a session recorder (masked by default, only with consent).
