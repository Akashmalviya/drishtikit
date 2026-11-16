# Load test result

Acme example API. 200 requests each second for 60 seconds (after 5 seconds of warm-up), 10 connections.
Mixed routes (one in five answers 404 on purpose), 200 different people, 3 teams. The "with" runs flush each 15 seconds (the MongoDB mode writes to a MongoDB in memory).

| Run | Requests | Errors | 404 (expected) | p50 (ms) | p95 (ms) | p99 (ms) | Mean (ms) | Memory at start (MB) | Memory peak (MB) | Memory at end (MB) |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| without Drishtikit, round 1 | 12000 | 0 | 2400 | 0.848 | 2.011 | 2.797 | 0.940 | 117.1 | 122.3 | 121.6 |
| with Drishtikit (MongoDB in memory), round 1 | 12000 | 0 | 2400 | 0.984 | 2.415 | 3.555 | 1.127 | 118.6 | 129.8 | 129.8 |
| without Drishtikit, round 2 | 12000 | 0 | 2400 | 0.844 | 2.100 | 3.033 | 0.957 | 117.6 | 122.7 | 121.8 |
| with Drishtikit (MongoDB in memory), round 2 | 12000 | 0 | 2400 | 0.976 | 2.403 | 3.661 | 1.113 | 118.8 | 129.8 | 129.7 |

Median over 2 round(s), with Drishtikit (MongoDB in memory) minus without: p50 0.136 ms, p95 0.315 ms, memory peak 7.1 MB.

## Time added to one request

The load numbers above include the noise of the load generator, which shares this machine. This second test removes that noise.

Time added to one request (one connection, 20000 requests per run, 4 runs each, alternating):
- without Drishtikit: 88.2, 86.9, 81.1, 80.5 microseconds per request (median 86.9).
- with Drishtikit: 90.0, 97.1, 90.4, 91.8 microseconds per request (median 91.8).
- Difference of the medians: 4.9 microseconds (0.005 ms). The target is less than 100 microseconds.


Date: 2026-11-16T11:24:59.150Z. Node v22.23.3.
