import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  buildEmitter,
  cleanupFixtures,
  compileFixture,
  compileFixtureExpectingDiagnostics,
} from "./compile-fixture.js";

afterAll(cleanupFixtures);
beforeAll(buildEmitter);

const exactNumericSpec = `
import "@typespec/http";
using TypeSpec.Http;

@service namespace ExactNumericApi;

enum ExactChoice {
  small: 7,
  max: 18446744073709551615,
}

model Payload {
  safe: 9007199254740991;
  signed: 9223372036854775807;
  choice: ExactChoice;
}

model MaxVariant {
  kind: 9223372036854775807;
  value: string;
}

model SmallVariant {
  kind: 7;
  value: string;
}

union Variant {
  max: MaxVariant,
  small: SmallVariant,
}

model MaxResponse {
  @statusCode status: 200;
  kind: 9223372036854775807;
  value: string;
}

model SmallResponse {
  @statusCode status: 201;
  kind: 7;
  value: string;
}

@route("/payload")
@post
op roundTrip(@body body: Payload): Payload;

@route("/query")
@get
op query(
  @query value: 9223372036854775807,
  @query choice: ExactChoice,
): void;

@route("/variant")
@post
op variant(@body body: Variant): Variant;

@route("/response")
@get
op response(): MaxResponse | SmallResponse;
`;

describe("exact TypeSpec numeric literals", () => {
  test("preserves safe numbers and unsafe integers across generated contracts", async () => {
    const result = compileFixture("numeric-literals", exactNumericSpec);
    const models = result.readFile("exact-numeric-api", "models.ts");
    const operations = result.readFile("exact-numeric-api", "server-operations.ts");

    expect(models).toContain("export type ExactChoice = 7 | 18446744073709551615n;");
    expect(models).toContain("safe: 9007199254740991;");
    expect(models).toContain("signed: 9223372036854775807n;");
    expect(operations).toContain("Decoders.strictLiteral(9223372036854775807n)");
    expect(operations).toContain("Decoders.literal(18446744073709551615n)");
    expect(operations).toContain("=== 9223372036854775807n");

    result.typecheck("exact-numeric-api", {
      "numeric-contract.ts": `
        import type { Payload } from "./models.js";
        const valid: Payload = {
          safe: 9007199254740991,
          signed: 9223372036854775807n,
          choice: 18446744073709551615n,
        };
        void valid;
        // @ts-expect-error Unsafe integer literals use bigint, not rounded numbers.
        const rounded: Payload = { safe: 9007199254740991, signed: 9223372036854776000, choice: 7 };
        void rounded;
      `,
    });

    const { createExactNumericApiServerRouter } = await import(
      `${result.outputDir}/exact-numeric-api/server-router.ts`
    );
    let receivedPayload: unknown;
    let receivedQuery: unknown;
    let receivedVariant: unknown;
    const router = createExactNumericApiServerRouter({
      roundTrip(input: unknown) {
        receivedPayload = input;
        return input;
      },
      query(input: unknown) {
        receivedQuery = input;
      },
      variant(input: unknown) {
        receivedVariant = input;
        return input;
      },
      response() {
        return {
          kind: 9223372036854775807n,
          value: "exact",
        };
      },
    } as any);

    const payload = await router.handle(
      new Request("http://localhost/payload", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: '{"safe":9007199254740991,"signed":9.223372036854775807e18,"choice":18446744073709551615}',
      }),
    );
    expect(payload.status).toBe(200);
    expect(receivedPayload).toEqual({
      safe: 9007199254740991,
      signed: 9223372036854775807n,
      choice: 18446744073709551615n,
    });
    expect(await payload.text()).toBe(
      '{"safe":9007199254740991,"signed":9223372036854775807,"choice":18446744073709551615}',
    );

    const query = await router.handle(
      new Request("http://localhost/query?value=9223372036854775807&choice=18446744073709551615"),
    );
    expect(query.status).toBe(204);
    expect(receivedQuery).toEqual({
      value: 9223372036854775807n,
      choice: 18446744073709551615n,
    });

    const variant = await router.handle(
      new Request("http://localhost/variant", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: '{"kind":9223372036854775807,"value":"max"}',
      }),
    );
    expect(variant.status).toBe(200);
    expect(receivedVariant).toEqual({ kind: 9223372036854775807n, value: "max" });
    expect(await variant.text()).toBe('{"kind":9223372036854775807,"value":"max"}');

    const invalid = await router.handle(
      new Request("http://localhost/variant", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: '{"kind":9223372036854775806,"value":"unknown"}',
      }),
    );
    expect(invalid.status).toBe(400);

    const encodedResponse = await router.handle(new Request("http://localhost/response"));
    expect(encodedResponse.status).toBe(200);
    expect(encodedResponse.headers.get("content-type")).toBe("application/json");
    expect(await encodedResponse.text()).toBe('{"kind":9223372036854775807,"value":"exact"}');
  });

  test("rejects numeric literals the runtime cannot preserve exactly", () => {
    const result = compileFixtureExpectingDiagnostics(
      "unsupported-numeric-literals",
      `
      import "@typespec/http";
      using TypeSpec.Http;

      @service namespace UnsupportedNumericApi;
      model Payload {
        decimal: 12345678901234567890.123456789;
        tooWide: 100000000000000000000;
      }
      @post op create(@body body: Payload): void;
    `,
    );

    const diagnostics = `${result.diagnostics.stdout}\n${result.diagnostics.stderr}`;
    expect(
      diagnostics.match(/@typespex\/http-emitter\/unsupported-numeric-literal:/g)?.length,
    ).toBe(2);
    expect(diagnostics).toContain("12345678901234567890.123456789");
    expect(diagnostics).toContain("100000000000000000000");
    expect(result.listFiles("unsupported-numeric-api")).toEqual([]);
  });
});
