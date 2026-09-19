# HTTP benchmarks

Run `bun run bench:http` to build the current checkout and compare TypeSpex, Hono,
Hono with Zod validation, Elysia, and bare Bun. Hono with Zod and Elysia perform the
query and body validation used by the TypeSpex workloads; bare Bun and plain Hono
provide comparisons without that validation.

GET requests include a query with 29 unused fields to measure whether reading the
declared parameters does unnecessary work on the rest of the query.

POST requests cover both compact and formatted JSON with the same validated
payload and expected response, so parsing comparisons include both representations.

The harness starts a fresh server for each measurement, warms it up, rotates server
and scenario order across repeated trials, and checks exact response bodies and
status codes. It records medians, median absolute deviations, individual trials,
runtime and dependency versions, and machine details. Results go to `.context/`.

To compare another TypeSpex revision, install its dependencies and build it in a
separate checkout, then run:

```sh
TYPESPEX_BENCH_BASELINE_ROOT=/path/to/built/checkout bun run bench:http
```

The baseline runs on port 3460. The artifact includes both revisions and paired
throughput ratios, so changes can be assessed within each trial. Override
`TYPESPEX_BENCH_TRIALS`, `TYPESPEX_BENCH_DURATION`, and `TYPESPEX_BENCH_WARMUP` to
adjust repetitions and timing; `TYPESPEX_BENCH_OUTPUT` selects the JSON file.
Both revisions must expose the same benchmark routes and response fixtures;
changes to that contract cause validation to fail rather than compare different workloads.

The **HTTP runtime benchmark** workflow runs relevant pull requests on a separate
Ubuntu runner. It builds both revisions before measuring and uploads the raw JSON
as an `http-runtime-comparison-attempt-N` artifact. It can also be run manually with a
baseline branch, tag, or commit. A successful run verifies response correctness;
throughput changes are reported for review without a fixed performance threshold.
Pull requests compare their merge commit against its verified base parent. Manual
runs compare the selected ref tips. Measurements are checkpointed between cells,
so an interrupted run retains its last completed cells with `complete: false`.
