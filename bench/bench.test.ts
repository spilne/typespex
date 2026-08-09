import { describe, expect, test } from "bun:test";
import {
  autocannonOptions,
  type BenchmarkScenario,
  SCENARIOS,
  seedPets,
  validateScenario,
} from "./bench.js";

describe("HTTP benchmark scenarios", () => {
  test("passes the create method, headers, and body to autocannon", () => {
    const create = SCENARIOS.find((scenario) => scenario.name.includes("create"));
    expect(create).toBeDefined();

    const options = autocannonOptions("http://localhost:3456/pets", create!);
    expect(options.method).toBe("POST");
    expect(options.headers).toEqual({ "content-type": "application/json" });
    expect(options.body).toBe(JSON.stringify({ name: "Bench", tag: "test" }));
  });

  test("preflights the configured request and expected response status", async () => {
    const scenario: BenchmarkScenario = {
      name: "POST /pets (create)",
      path: "/pets",
      method: "POST",
      headers: { "content-type": "application/json" },
      body: '{"name":"Bench"}',
      expectedStatus: 201,
    };
    let received:
      | { readonly input: string | URL | Request; readonly init?: RequestInit }
      | undefined;

    await validateScenario("http://localhost:3456/pets", scenario, async (input, init) => {
      received = { input, init };
      return new Response("created", { status: 201 });
    });

    expect(received?.input).toBe("http://localhost:3456/pets");
    expect(received?.init).toMatchObject({
      method: "POST",
      headers: { "content-type": "application/json" },
      body: '{"name":"Bench"}',
    });
  });

  test("fails preflight when an implementation does not reach the expected operation", async () => {
    const create = SCENARIOS.find((scenario) => scenario.name.includes("create"))!;
    await expect(
      validateScenario(
        "http://localhost:3456/pets",
        create,
        async () => new Response("not found", { status: 404 }),
      ),
    ).rejects.toThrow("expected 200 for POST");
  });

  test("fails before measurement when a seed request does not reach POST behavior", async () => {
    const requests: RequestInit[] = [];

    await expect(
      seedPets({ name: "broken", port: 3456 }, 2, async (_input, init) => {
        requests.push(init ?? {});
        return new Response(null, { status: requests.length === 1 ? 200 : 404 });
      }),
    ).rejects.toThrow("broken seed request 2/2 returned 404; expected 200");

    expect(requests).toHaveLength(2);
    expect(requests[0]).toMatchObject({
      method: "POST",
      headers: { "content-type": "application/json" },
    });
  });
});
