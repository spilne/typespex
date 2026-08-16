import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  buildEmitter,
  cleanupFixtures,
  compileFixture,
  compileFixtureExpectingDiagnostics,
} from "./compile-fixture.js";

afterAll(cleanupFixtures);
beforeAll(buildEmitter);

const scalarEncodingSpec = `
import "@typespec/http";
using TypeSpec.Http;

@service(#{ title: "ScalarEncodingApi" })
namespace ScalarEncodingApi;

@minLength(4)
scalar FourCharString extends string;

model EncodedPayload {
  @encode("unixTimestamp", int32) createdAt: utcDateTime;
  @encode(string) id: int64;
  @encode(string) enabled: boolean;
  @encode("seconds", float64) ttl: duration;
  @encode("milliseconds", int64) delay: duration;
  @encode("base64url") token: bytes;
  @encode("base64") raw: bytes;
  @encode("rfc7231") updatedAt: offsetDateTime;
  @encode("ISO8601", FourCharString) period: duration;
  legacy: unixTimestamp32;
  defaultDate: utcDateTime;
  defaultDuration: duration;
  defaultBytes: bytes;
  @encode(string) nullableId: int64 | null;
}

model HeaderResponse {
  @header("x-created-at") @encode("unixTimestamp", int32)
  createdAt: utcDateTime;

  @header("x-id") @encode(string)
  id: int64;

  @header("x-default-date")
  defaultDate: utcDateTime;

  @header("x-explicit-date") @encode("rfc3339")
  explicitDate: utcDateTime;

  @body body: EncodedPayload;
}

model TextDateResponse {
  @header contentType: "text/plain";
  @body @encode("rfc7231") body: utcDateTime;
}

model TextBytesResponse {
  @header contentType: "text/plain";
  @body body: bytes;
}

@route("/payload")
@post
op roundTrip(@body body: EncodedPayload): EncodedPayload;

@route("/parameters/{when}")
@get
op parameters(
  @path @encode("unixTimestamp", int32) when: utcDateTime,
  @query @encode(string) count: int64,
  @header("x-enabled") @encode(string) enabled: boolean,
  @header("x-default-date") defaultDate: utcDateTime,
  @header("x-explicit-date") @encode("rfc3339") explicitDate: utcDateTime,
  @cookie("token") @encode("base64url") token: bytes,
): void;

@route("/headers")
@get
op headers(): HeaderResponse;

@route("/text-date")
@post
op textDate(
  @header contentType: "text/plain",
  @body @encode("unixTimestamp", int32) body: utcDateTime,
): TextDateResponse;

@route("/text-bytes")
@post
op textBytes(
  @header contentType: "text/plain",
  @body body: bytes,
): TextBytesResponse;
`;

const handlerPayload = {
  createdAt: "1970-01-01T00:00:00.000Z",
  id: 9223372036854775807n,
  enabled: true,
  ttl: "PT1.5S",
  delay: "PT1.5S",
  token: new Uint8Array([255]),
  raw: new Uint8Array([255]),
  updatedAt: "2024-01-02T03:04:05.000Z",
  period: "PT1S",
  legacy: "1970-01-01T00:00:01.000Z",
  defaultDate: "2024-01-02T03:04:05.000Z",
  defaultDuration: "PT2S",
  defaultBytes: new Uint8Array([1, 2]),
  nullableId: 42n,
};

const wirePayload = {
  createdAt: 0,
  id: "9223372036854775807",
  enabled: "true",
  ttl: 1.5,
  delay: 1500,
  token: "_w",
  raw: "/w==",
  updatedAt: "Tue, 02 Jan 2024 03:04:05 GMT",
  period: "PT1S",
  legacy: 1,
  defaultDate: "2024-01-02T03:04:05.000Z",
  defaultDuration: "PT2S",
  defaultBytes: "AQI=",
  nullableId: "42",
};

describe("TypeSpec scalar encodings", () => {
  test("decodes and serializes standard encodings in bodies and HTTP metadata", async () => {
    const result = compileFixture("scalar-encodings", scalarEncodingSpec);
    const operations = result.readFile("scalar-encoding-api", "server-operations.ts");

    expect(operations).toContain("Decoders.unixTimestamp");
    expect(operations).toContain("Decoders.encodedBigIntString");
    expect(operations).toContain("Decoders.encodedBooleanString");
    expect(operations).toContain("Decoders.numericDuration");
    expect(operations).toContain("Decoders.base64UrlBytes");
    expect(operations).toContain("Decoders.compose");
    expect(operations).toContain("JsonSerializers.unixTimestamp");
    expect(operations).toContain("JsonSerializers.numericDuration");
    expect(operations).toContain("JsonSerializers.base64UrlBytes");
    expect(operations).toContain("JsonSerializers.validate");
    result.typecheck("scalar-encoding-api");

    const { createScalarEncodingApiServerRouter } = await import(
      `${result.outputDir}/scalar-encoding-api/server-router.ts`
    );
    let receivedPayload: unknown;
    let receivedParameters: unknown;
    let receivedTextDate: unknown;
    let receivedTextBytes: unknown;
    const router = createScalarEncodingApiServerRouter({
      roundTrip: (input: unknown) => {
        receivedPayload = input;
        return input;
      },
      parameters: (input: unknown) => {
        receivedParameters = input;
      },
      headers: () => ({
        createdAt: handlerPayload.createdAt,
        id: handlerPayload.id,
        defaultDate: handlerPayload.defaultDate,
        explicitDate: handlerPayload.defaultDate,
        body: handlerPayload,
      }),
      textDate: (input: unknown) => {
        receivedTextDate = input;
        return { body: "2024-01-02T03:04:05Z" };
      },
      textBytes: (input: { body: Uint8Array }) => {
        receivedTextBytes = input;
        return { body: input.body };
      },
    } as any);

    const roundTrip = await router.handle(
      new Request("http://localhost/payload", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(wirePayload),
      }),
    );
    expect(roundTrip.status).toBe(200);
    expect(receivedPayload).toEqual(handlerPayload);
    expect(await roundTrip.json()).toEqual(wirePayload);

    const invalidWireConstraint = await router.handle(
      new Request("http://localhost/payload", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...wirePayload, period: "P1Y" }),
      }),
    );
    expect(invalidWireConstraint.status).toBe(400);
    expect(receivedPayload).toEqual(handlerPayload);

    const invalidDefaultDate = await router.handle(
      new Request("http://localhost/payload", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...wirePayload, defaultDate: "2023-02-29T00:00:00Z" }),
      }),
    );
    expect(invalidDefaultDate.status).toBe(400);

    const parameters = await router.handle(
      new Request("http://localhost/parameters/0?count=9223372036854775807", {
        headers: {
          cookie: "token=_w",
          "x-enabled": "TRUE",
          "x-default-date": "Tue, 02 Jan 2024 03:04:05 GMT",
          "x-explicit-date": "2024-01-02T03:04:05Z",
        },
      }),
    );
    expect(parameters.status).toBe(204);
    expect(receivedParameters).toEqual({
      when: "1970-01-01T00:00:00.000Z",
      count: 9223372036854775807n,
      enabled: true,
      defaultDate: "2024-01-02T03:04:05.000Z",
      explicitDate: "2024-01-02T03:04:05Z",
      token: new Uint8Array([255]),
    });

    const headers = await router.handle(new Request("http://localhost/headers"));
    expect(headers.status).toBe(200);
    expect(headers.headers.get("x-created-at")).toBe("0");
    expect(headers.headers.get("x-id")).toBe("9223372036854775807");
    expect(headers.headers.get("x-default-date")).toBe("Tue, 02 Jan 2024 03:04:05 GMT");
    expect(headers.headers.get("x-explicit-date")).toBe("2024-01-02T03:04:05.000Z");
    expect(await headers.json()).toEqual(wirePayload);

    const textDate = await router.handle(
      new Request("http://localhost/text-date", {
        method: "POST",
        headers: { "content-type": "text/plain" },
        body: "0",
      }),
    );
    expect(textDate.status).toBe(200);
    expect(receivedTextDate).toEqual({
      contentType: "text/plain",
      body: "1970-01-01T00:00:00.000Z",
    });
    expect(textDate.headers.get("content-type")).toBe("text/plain");
    expect(await textDate.text()).toBe("Tue, 02 Jan 2024 03:04:05 GMT");

    const textBytes = await router.handle(
      new Request("http://localhost/text-bytes", {
        method: "POST",
        headers: { "content-type": "text/plain" },
        body: "/w==",
      }),
    );
    expect(textBytes.status).toBe(200);
    expect(receivedTextBytes).toEqual({
      contentType: "text/plain",
      body: new Uint8Array([255]),
    });
    expect(await textBytes.text()).toBe("/w==");
  });

  test("rejects unsupported and ambiguous scalar encoding contracts before emission", () => {
    const custom = compileFixtureExpectingDiagnostics(
      "scalar-encoding-custom",
      `
      import "@typespec/http";
      using TypeSpec.Http;
      @service namespace CustomEncodingApi {
        @encode("rot13") scalar Secret extends string;
        @route("/secret") @get op read(): Secret;
      }
    `,
    );
    const customDiagnostics = `${custom.diagnostics.stdout}\n${custom.diagnostics.stderr}`;
    expect(customDiagnostics).toContain("unsupported-scalar-encoding");
    expect(customDiagnostics).toContain("rot13");
    expect(custom.listFiles("custom-encoding-api")).toEqual([]);

    const binary = compileFixtureExpectingDiagnostics(
      "scalar-encoding-binary",
      `
      import "@typespec/http";
      using TypeSpec.Http;
      @service namespace BinaryEncodingApi {
        @route("/bytes") @post op write(
          @header contentType: "application/octet-stream",
          @body @encode("base64url") body: bytes,
        ): void;
      }
    `,
    );
    const binaryDiagnostics = `${binary.diagnostics.stdout}\n${binary.diagnostics.stderr}`;
    expect(binaryDiagnostics).toContain("unsupported-request-body");
    expect(binaryDiagnostics).toContain("binary bodies cannot apply scalar encoding");
    expect(binary.listFiles("binary-encoding-api")).toEqual([]);

    const ambiguous = compileFixtureExpectingDiagnostics(
      "scalar-encoding-ambiguous-response",
      `
      import "@typespec/http";
      using TypeSpec.Http;
      @service namespace AmbiguousEncodingApi {
        @encode("rfc7231") scalar HttpDate extends utcDateTime;
        union TextValue { date: HttpDate, raw: string }
        model HeaderResponse {
          @header("x-value") value: TextValue;
          @body body: string;
        }
        @route("/text") @get op text(): {
          @header contentType: "text/plain";
          @body body: TextValue;
        };
        @route("/header") @get op header(): HeaderResponse;
      }
    `,
    );
    const ambiguousDiagnostics = `${ambiguous.diagnostics.stdout}\n${ambiguous.diagnostics.stderr}`;
    expect(ambiguousDiagnostics).toContain("unsupported-response-body");
    expect(ambiguousDiagnostics).toContain("unsupported-response-header");
    expect(ambiguousDiagnostics).toContain("multiple wire-transforming variants");
    expect(ambiguous.listFiles("ambiguous-encoding-api")).toEqual([]);
  });
});
