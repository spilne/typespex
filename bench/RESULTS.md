# HTTP runtime measurements

These measurements compare real HTTP requests on Bun 1.3.14 using Autocannon 8.0.0,
50 connections, pipelining 1, five trials, and 2 seconds of discarded warmup followed by
10 seconds of measurement per cell. Every cell starts a fresh server. Method, status,
content type, and exact response body are checked before and after load; timed responses
are checked for body mismatches, exact status counts, transport errors, timeouts, and resets.
All reported runs completed without those errors. Rates below are median requests/second
± median absolute deviation (MAD), not a statistical confidence interval.

The host was a shared Apple M1 Pro laptop (10 logical CPUs, 16 GiB, macOS arm64).
An unrelated background process occupied approximately one CPU core. No tests or builds
ran alongside the measured cells. Use the paired comparisons as evidence for these
fixtures on this host; absolute rates are not dedicated-machine capacity claims.

The fixtures bind the same four routes, return identical JSON, and use a bounded,
deterministic collection. Hono+Zod validates the list query and POST body; the read routes
have no Zod schema. Elysia uses matching input constraints and its normal native Bun
integration. Bare Bun and plain Hono do not perform schema validation. TypeSpex retains
lossless integer/byte JSON semantics and request-body limits, so these are equivalent
application responses, not identical framework feature sets. Versions: Hono 4.13.7,
Zod 4.5.4, @hono/zod-validator 0.9.1, Elysia 1.4.30.

## First optimization batch

[Raw trials, schedule, metadata, and aggregates](results/2026-09-13-http.json).
The baseline HTTP sources are from `7fe006d`; the optimized sources are from `43bb211`,
merged into master as `6ede99c` ([PR #296](https://github.com/spilne/typespex/pull/296)).
This run contains 100 measured cells.

| Scenario                |       Bare Bun |           Hono |       Hono+Zod | TypeSpex before | TypeSpex first batch |
| ----------------------- | -------------: | -------------: | -------------: | --------------: | -------------------: |
| GET /pets?limit=10      | 75,718 ± 1,299 | 67,045 ± 2,539 |   52,810 ± 835 |    42,147 ± 262 |         46,509 ± 291 |
| GET /pets/:id (success) |   91,021 ± 198 | 83,174 ± 1,370 | 81,862 ± 1,568 |    67,822 ± 675 |       72,896 ± 1,216 |
| GET /pets/:id (404)     | 90,304 ± 4,883 | 82,822 ± 3,053 | 86,533 ± 5,531 |  62,122 ± 2,886 |       69,146 ± 3,469 |
| POST /pets (create)     | 82,272 ± 5,062 | 72,704 ± 1,133 |   59,043 ± 810 |    18,834 ± 138 |         19,038 ± 435 |

Routing and serialization improved GET throughput, but the POST body-stream wrapper
remained the dominant bottleneck. This batch did not establish a lead over Hono+Zod.

## Runtime optimization comparison

[Raw trials, schedule, metadata, and aggregates](results/2026-09-14-runtime-http.json).
This run contains 80 measured cells. The baseline is master `6ede99c`. The candidate
preserves native Bun buffering for verified fixed-length bodies, avoids a second JSON
parse and object copy for ordinary input, and reduces JSON quoting/header allocations.
The adapter API was subsequently adjusted to keep `handle(request)` and wrapper behavior compatible, bind
transport facts to the original Request, and defer native body access. Later measurements
are reported separately below.

| Scenario                |       Hono+Zod |         Elysia | TypeSpex first batch | TypeSpex candidate |
| ----------------------- | -------------: | -------------: | -------------------: | -----------------: |
| GET /pets?limit=10      | 50,803 ± 2,598 |   60,138 ± 906 |         44,381 ± 470 |     47,962 ± 1,776 |
| GET /pets/:id (success) | 79,725 ± 1,011 | 87,418 ± 2,976 |       67,878 ± 1,478 |     67,426 ± 4,050 |
| GET /pets/:id (404)     | 78,842 ± 7,142 | 84,608 ± 6,426 |       65,510 ± 2,373 |     65,733 ± 5,973 |
| POST /pets (create)     | 57,210 ± 1,837 | 72,506 ± 3,347 |         18,672 ± 515 |     44,611 ± 1,229 |

## Confirmation at b0723c4

[Raw trials, schedule, metadata, and aggregates](results/2026-09-14-runtime-confirmation.json).
Five further paired trials (40 measured cells) compare `b0723c4` against master `6ede99c`.
This predates the final router-wrapper guard and deferred native body access.

| Scenario                | TypeSpex master 6ede99c | TypeSpex b0723c4 |
| ----------------------- | ----------------------: | ---------------: |
| GET /pets?limit=10      |            48,141 ± 899 |   50,150 ± 1,286 |
| GET /pets/:id (success) |          71,198 ± 1,128 |   75,648 ± 1,715 |
| GET /pets/:id (404)     |          71,392 ± 1,363 |     72,115 ± 608 |
| POST /pets (create)     |            19,178 ± 226 |     48,442 ± 803 |

## Reproduce

Install the pinned Bun 1.3.14 runtime, run `bun install --frozen-lockfile`, then
`bun run bench:http`. This builds the current workspace, verifies generated fixtures,
and benchmarks Bare Bun, Hono, Hono+Zod, Elysia, and TypeSpex. Allow about 20 minutes
plus build/startup time. Settings and output controls are documented in the root README.
Run on an idle host for capacity measurements. Historical rows above use their recorded
source revisions; running the command on a newer revision measures that newer revision.

Older benchmark figures are not directly comparable: earlier POST-labelled measurements
sent GET requests (fixed in PR #94), and the harness later changed fixture state, server
isolation, validation, and pipelining. No surviving earlier winning run was used as evidence
for the current relative performance.
