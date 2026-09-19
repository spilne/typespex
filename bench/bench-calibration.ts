// Prebuilt responses remove routing, decoding, validation, and serialization from
// the control. Requests and response payloads still match each measured scenario.
const body = Bun.env.TYPESPEX_BENCH_CONTROL_BODY;
const status = Number(Bun.env.TYPESPEX_BENCH_CONTROL_STATUS);
if (body === undefined || !Number.isInteger(status)) throw new Error("Missing control fixture.");

Bun.serve({
  port: Number(Bun.env.TYPESPEX_BENCH_PORT),
  routes: {
    "/__bench_health": new Response("ok"),
    "/*": new Response(body, { status, headers: { "content-type": "application/json" } }),
  },
});
