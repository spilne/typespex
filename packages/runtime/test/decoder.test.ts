import { describe, expect, test } from "bun:test";
import {
  Either,
  ValidationError,
  decodeFields,
  decodeFieldsAndBody,
  isLeft,
  mapNFields,
  mapFieldDecoder,
  numberCodec,
  objectCodec,
  optional,
  optionalHeader,
  optionalQuery,
  requiredHeader,
  requiredPath,
  requiredQuery,
  stringCodec,
} from "../src/server.js";
import type { FieldDecoder } from "../src/server.js";

describe("http field decoders (sync)", () => {
  test("mapNFields builds typed objects applicatively", () => {
    const decoder = mapNFields(
      [
        requiredPath("petId", stringCodec),
        optionalQuery("limit", numberCodec),
        optionalHeader("x-trace-id", stringCodec),
      ],
      (petId, limit, traceId) => ({ petId, limit, traceId }),
    );
    const typedDecoder: FieldDecoder<{
      petId: string;
      limit?: number;
      traceId?: string;
    }> = decoder;
    void typedDecoder;

    const decoded = decoder.decode({
      pathParams: { petId: "p-1" },
      query: new URLSearchParams("limit=2"),
      headers: new Headers({ "x-trace-id": "trace-1" }),
    });

    expect(decoded).toEqual(Either.right({
      petId: "p-1",
      limit: 2,
      traceId: "trace-1",
    }));
  });

  test("accumulates field validation issues synchronously", () => {
    const decoder = mapNFields(
      [
        requiredPath("petId", stringCodec),
        requiredQuery("limit", numberCodec),
      ],
      (petId, limit) => ({ petId, limit }),
    );

    const decoded = decoder.decode({
      pathParams: {},
      query: new URLSearchParams("limit=bad"),
      headers: new Headers(),
    });

    expect(decoded._tag).toBe("Left");
    if (decoded._tag === "Left") {
      expect(decoded.left).toEqual([
        { path: "$path.petId", message: "Required value is missing." },
        { path: "$query.limit", message: "Expected a finite number." },
      ]);
    }
  });

  test("decodeFields returns Either.right on success", () => {
    const decoder = mapFieldDecoder(
      requiredPath("petId", stringCodec),
      (petId) => ({ petId }),
    );

    const result = decodeFields(
      decoder,
      new Request("http://localhost/pets/p-1"),
      { petId: "p-1" },
    );

    expect(result).toEqual(Either.right({ petId: "p-1" }));
  });

  test("decodeFields returns Either.left on failure", () => {
    const decoder = mapNFields(
      [requiredPath("petId", stringCodec)],
      (petId) => ({ petId }),
    );

    const result = decodeFields(
      decoder,
      new Request("http://localhost/pets"),
      {},
    );

    expect(isLeft(result)).toBe(true);
    if (isLeft(result)) {
      expect(result.left).toBeInstanceOf(ValidationError);
    }
  });

  test("mapFieldDecoder lifts one field decoder into an object", () => {
    const decoder = mapFieldDecoder(
      requiredPath("petId", stringCodec),
      (petId) => ({ petId }),
    );

    const decoded = decoder.decode({
      pathParams: { petId: "p-1" },
      query: new URLSearchParams(),
      headers: new Headers(),
    });

    expect(decoded).toEqual(Either.right({ petId: "p-1" }));
  });

  test("decodeFieldsAndBody returns Either.right merging fields and body", async () => {
    const fieldDecoder = mapFieldDecoder(
      requiredPath("petId", stringCodec),
      (petId) => ({ petId }),
    );
    const bodyCodec = objectCodec<{ name: string }>({
      name: stringCodec,
    });

    const result = await decodeFieldsAndBody(
      fieldDecoder,
      bodyCodec,
      new Request("http://localhost/pets/p-1", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "Milo" }),
      }),
      { petId: "p-1" },
    );

    expect(result).toEqual(Either.right({ petId: "p-1", name: "Milo" }));
  });

  test("decodeFieldsAndBody accumulates errors from both as Left", async () => {
    const fieldDecoder = mapNFields(
      [requiredPath("petId", stringCodec)],
      (petId) => ({ petId }),
    );
    const bodyCodec = objectCodec<{ name: string }>({
      name: stringCodec,
    });

    const result = await decodeFieldsAndBody(
      fieldDecoder,
      bodyCodec,
      new Request("http://localhost/pets", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: 42 }),
      }),
      {},
    );

    expect(isLeft(result)).toBe(true);
    if (isLeft(result)) {
      expect(result.left).toBeInstanceOf(ValidationError);
      expect(result.left.issues).toEqual([
        { path: "$path.petId", message: "Required value is missing." },
        { path: "$body.name", message: "Expected a string." },
      ]);
    }
  });

  test("requiredHeader decodes present header and fails on missing", () => {
    const decoder = mapNFields(
      [requiredHeader("x-api-key", stringCodec)],
      (apiKey) => ({ apiKey }),
    );

    const ok = decoder.decode({
      pathParams: {},
      query: new URLSearchParams(),
      headers: new Headers({ "x-api-key": "secret" }),
    });
    expect(ok).toEqual(Either.right({ apiKey: "secret" }));

    const missing = decoder.decode({
      pathParams: {},
      query: new URLSearchParams(),
      headers: new Headers(),
    });
    expect(isLeft(missing)).toBe(true);
    if (isLeft(missing)) {
      expect(missing.left).toEqual([
        { path: "$header.x-api-key", message: "Required value is missing." },
      ]);
    }
  });
});
