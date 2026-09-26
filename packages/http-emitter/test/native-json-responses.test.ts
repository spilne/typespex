import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { buildEmitter, cleanupFixtures, compileFixture } from "./compile-fixture.js";

afterAll(cleanupFixtures);
beforeAll(buildEmitter, 120_000);

const nativeSpec = `
import "@typespec/http";
using TypeSpec.Http;

@service(#{ title: "NativeJsonApi" })
namespace NativeJsonApi;

enum Kind { Dog: "dog", Cat: "cat" }

model Owner { name: string; rating: float32; }

model Pet {
  id: string;
  name: string;
  age: int32;
  weight: float64;
  active: boolean;
  kind: Kind;
  owner?: Owner;
  nicknames: string[];
  parent: Pet | null;
  coordinates: [float64, float64];
  status: "adopted" | 42;
}

model Enveloped {
  @header("x-request-id") requestId: string;
  ...Pet;
}

model Created {
  @statusCode _: 201;
  @header("x-request-id") requestId: string;
  ...Pet;
}

model NotFoundError {
  @statusCode _: 404;
  code: "NOT_FOUND";
  message: string;
}

model Encoded {
  modified: utcDateTime;
  @encode(DateTimeKnownEncoding.rfc7231) seen: utcDateTime;
  @encode("base64url") avatar: bytes;
  @encode(string) total: int64;
  @encode(DateTimeKnownEncoding.unixTimestamp, int32) visited: utcDateTime;
}

@route("/pets")
interface Pets {
  @get list(): Pet[];
  @get read(@path id: string): Pet | NotFoundError;
  @post create(@body body: Pet): Created;
  @route("/enveloped") @get enveloped(): Enveloped;
  @route("/encoded") @get encoded(): Encoded;
}
`;

const losslessSpec = `
import "@typespec/http";
using TypeSpec.Http;

@service(#{ title: "LosslessJsonApi" })
namespace LosslessJsonApi;

model Counter { id: string; value: int64; }
model Blob { id: string; payload: bytes; }
model Bag { id: string; extra: unknown; }
model Labels { id: string; labels: Record<string>; }
model Wide { id: string; big: 12345678901234567890; }
model Timestamp {
  @encode(DateTimeKnownEncoding.unixTimestamp, int64) seen: utcDateTime;
}
model Nested { id: string; counters: Counter[]; }

@route("/lossless")
interface Lossless {
  @route("/counter") @get counter(): Counter;
  @route("/blob") @get blob(): Blob;
  @route("/bag") @get bag(): Bag;
  @route("/labels") @get labels(): Labels;
  @route("/wide") @get wide(): Wide;
  @route("/timestamp") @get timestamp(): Timestamp;
  @route("/nested") @get nested(): Nested;
}
`;

describe("native JSON response encoders", () => {
  test("responses without bigint or bytes wire values use the platform serializer", () => {
    const r = compileFixture("native-json", nativeSpec);
    const operations = r.readFile("native-json-api", "server-operations.ts");

    expect(operations).toContain("list: ResponseEncoders.nativeJson<Pet[]>(200)");
    expect(operations).toContain("encoder: ResponseEncoders.nativeJson<Pet>(200)");
    // Serializer and projection outputs are ordinary objects, so they stay native.
    expect(operations).toMatch(/ResponseEncoders\.nativeJson<unknown>\(404\)\.mapInput\(/);
    expect(operations).toMatch(
      /ResponseEncoders\.nativeJson<unknown>\(200\)\.mapInput\(\(value: Encoded\)/,
    );
    expect(operations).toMatch(
      /status: 200,[\s\S]*?headers: \[\["requestId", "x-request-id"\]\],[\s\S]*?nativeJson: true,/,
    );
    expect(operations).toMatch(/status: 201,[\s\S]*?transformBody: [\s\S]*?nativeJson: true,/);
    expect(operations).not.toContain("ResponseEncoders.json<");
    r.typecheck("native-json-api");
  });

  test("lossless wire values keep the runtime JSON writer", () => {
    const r = compileFixture("lossless-json", losslessSpec);
    const operations = r.readFile("lossless-json-api", "server-operations.ts");

    expect(operations).toContain("counter: ResponseEncoders.json<Counter>(200)");
    expect(operations).toContain("blob: ResponseEncoders.json<Blob>(200)");
    expect(operations).toContain("bag: ResponseEncoders.json<Bag>(200)");
    expect(operations).toContain("labels: ResponseEncoders.json<Labels>(200)");
    expect(operations).toContain("wide: ResponseEncoders.json<Wide>(200)");
    expect(operations).toMatch(
      /timestamp: ResponseEncoders\.json<unknown>\(200\)\.mapInput\(\(value: Timestamp\)/,
    );
    expect(operations).toContain("nested: ResponseEncoders.json<Nested>(200)");
    expect(operations).not.toContain("nativeJson");
    r.typecheck("lossless-json-api");
  });
});
