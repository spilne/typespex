import { benchmarkServerPort } from "./fixture.js";

// Prebuilt responses remove routing, decoding, validation, and serialization from
// the control. Requests and response payloads still match each measured scenario.
const body = Bun.env.TYPESPEX_BENCH_CONTROL_BODY;
const status = Number(Bun.env.TYPESPEX_BENCH_CONTROL_STATUS);
if (body === undefined || !Number.isInteger(status) || status < 200 || status > 599) {
  throw new Error("Missing or invalid control fixture.");
}

Bun.serve({
  port: benchmarkServerPort(3462),
  routes: {
    "/__bench_health": new Response("ok"),
    // Match Bun's Response.json header, including its charset, so the control
    // cannot gain headroom by sending a shorter content-type header.
    "/*": new Response(body, {
      status,
      headers: { "content-type": "application/json;charset=utf-8" },
    }),
  },
});
