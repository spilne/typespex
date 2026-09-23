# HTTP benchmarks

Run `bun run bench:http` to build the current checkout and compare TypeSpex, Hono,
Hono with Zod validation, Elysia, and bare Bun. Hono with Zod and Elysia perform the
query and body validation used by the TypeSpex workloads; bare Bun and plain Hono
provide comparisons without that validation.

One GET scenario adds 29 unused query fields alongside `limit` to measure whether
reading the declared parameters does unnecessary work on the rest of the query.

POST requests cover both compact and formatted JSON with the same validated
payload and expected response, so parsing comparisons include both representations.

The repository's benchmark and CI baseline is **Bun 1.4.2**. The harness uses
**oha 1.16.0**, a native HTTP load generator, and records the executing Bun version.
It downloads an official, SHA-256-verified oha binary into `.context/bench-tools/`
on macOS or Linux (ARM64 or x64). `TYPESPEX_BENCH_OHA=/absolute/path/to/oha` uses
an existing binary of that version; its checksum is recorded in the artifact.
No global installation is required.

Each measurement starts a fresh server with `NODE_ENV=production`, warms it up, and uses HTTP/1.1 keep-alive
with 500 connections and two client threads. Server and scenario order rotate
across trials. `TYPESPEX_BENCH_CONNECTIONS` and `TYPESPEX_BENCH_CLIENT_THREADS`
override those defaults. Throughput is unlimited and closed-loop; latency under
this saturated workload is not an application latency SLO. The old autocannon
pipelining and rate-limit settings are rejected instead of silently ignored.

**Client headroom is measured, not assumed.** Each scenario and trial includes a
Bun static-response control in a separate, sequential measurement window with
the same request and response payload, bypassing
application routing, validation, parsing, and serialization. The control must
outpace the fastest implementation by at least 25% in **every** paired trial.
Otherwise the scenario is marked **unverified** and comparative ratios are
withheld. Inspect `comparisonValidity` in the JSON before interpreting gaps.
The threshold is a conservative eligibility check, not a statistical significance
test or proof of the client's absolute capacity. Failing it can also mean that
the control server, shared CPU, or loopback stack is saturated; it does not prove
that the client alone is the bottleneck. Sweep client threads and connections,
or use a machine with more headroom, before drawing framework conclusions.
Passing establishes observed reserve in the control window; it does not exclude
shared-resource contention during another window or establish that a small gap
is real. Margins near the threshold are weak evidence: check sensitivity to client
threads and concurrency, variability, and independent repeated runs. The strict
minimum deliberately rejects a scenario if even one trial lacks sufficient reserve.

Every timed response contributes to exact status-code counts and response-byte
totals, and any client error invalidates the run. Exact response bodies and JSON
content types are checked before, after, and during load (approximately ten
additional probes per second). Body equality is **sampled**, not checked for
every oha response; matching byte totals alone cannot detect same-length changes.
The client drains in-flight requests at the deadline to avoid counting normal
cancellation as an error. Raw oha JSON, probe counts, medians, median absolute
deviations, individual trials, versions, and machine details go to `.context/`.

To compare another TypeSpex revision, install its dependencies and build it in a
separate checkout, then run:

```sh
TYPESPEX_BENCH_BASELINE_ROOT=/path/to/built/checkout bun run bench:http
```

The baseline runs on port 3460. The artifact includes both revisions and paired
throughput ratios, so changes can be assessed within each trial. Override
`TYPESPEX_BENCH_TRIALS`, `TYPESPEX_BENCH_DURATION`, and `TYPESPEX_BENCH_WARMUP` to
adjust repetitions and timing; `TYPESPEX_BENCH_OUTPUT` selects the JSON file.
Both revisions run under the same Bun executable and must expose the same benchmark routes and response fixtures;
changes to that contract cause validation to fail rather than compare different workloads.

The **HTTP runtime benchmark** workflow runs relevant pull requests on a separate
Ubuntu runner. It builds both revisions before measuring and uploads the raw JSON
as an `http-runtime-comparison-attempt-N` artifact. It can also be run manually with a
baseline branch, tag, or commit. A successful run verifies the correctness checks
above; it does not imply sufficient headroom. Only scenarios with verified
headroom publish comparative ratios, without a fixed regression threshold.
The job summary lists headroom for every scenario and emits a warning annotation
when any comparison is unverified.
Pull requests compare their merge commit against its verified base parent. Manual
runs compare the selected ref tips. Measurements are checkpointed between cells,
so an interrupted run retains its last completed cells with `complete: false`.
