import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { buildEmitter, cleanupFixtures, compileFixture } from "./compile-fixture.js";

afterAll(cleanupFixtures);
beforeAll(buildEmitter);

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const paramsSpec = `
import "@typespec/http";
using TypeSpec.Http;

@service(#{ title: "ParamsApi" })
namespace ParamsApi;

model Item { id: string; name: string; }

@route("/items")
interface Items {
  @get list(
    @query limit?: int32,
    @query offset?: int32,
    @header("x-request-id") requestId?: string,
  ): Item[];
}
`;

const validationSpec = `
import "@typespec/http";
using TypeSpec.Http;

@service(#{ title: "ValidationApi" })
namespace ValidationApi;

model CreateItem {
  @minLength(1) @maxLength(20)
  @pattern("^[A-Z].*", "Must start with uppercase.")
  name: string;

  @minItems(1) @maxItems(3)
  tags: string[];

  @minValue(0)
  count: int32;
}

@route("/items")
interface Items {
  @get list(
    @minValue(1) @maxValue(100) @query limit: int32,
    @minValueExclusive(0) @maxValueExclusive(1) @query ratio: float64,
  ): CreateItem[];

  @route("/{itemId}")
  @get read(@minValue(1) @path itemId: int64): CreateItem;

  @post create(@body body: CreateItem): CreateItem;
}
`;

const combinedSpec = `
import "@typespec/http";
using TypeSpec.Http;

@service(#{ title: "CombinedApi" })
namespace CombinedApi;

model UpdatePayload { name: string; tags?: string[]; }
model Item { id: string; name: string; tags?: string[]; }

@route("/items")
interface Items {
  @put update(
    @path itemId: string,
    @query dryRun?: boolean,
    @body body: UpdatePayload,
  ): Item;
}
`;

const cookieSpec = `
import "@typespec/http";
using TypeSpec.Http;

@service(#{ title: "CookieApi" })
namespace CookieApi;

model Profile { name: string; }

@route("/profile")
interface Users {
  @get me(@cookie sessionId: string, @cookie theme?: string): Profile;
}
`;

const recursiveSpec = `
import "@typespec/http";
using TypeSpec.Http;

@service(#{ title: "TreeApi" })
namespace TreeApi;

model TreeNode {
  value: string;
  children?: TreeNode[];
}

@route("/tree")
interface Tree {
  @post create(@body body: TreeNode): TreeNode;
}
`;

const sharedRecursiveSpec = `
import "@typespec/http";
using TypeSpec.Http;

@service(#{ title: "SharedTreeApi" })
namespace SharedTreeApi;

model TreeNode {
  value: string;
  children?: TreeNode[];
}

@route("/first")
interface First {
  @post create(@body body: TreeNode): TreeNode;
}

@route("/second")
interface Second {
  @post create(@body body: TreeNode): TreeNode;
}
`;

const collidingLazyDecoderNamesSpec = `
import "@typespec/http";
using TypeSpec.Http;

@service(#{ title: "LazyNameApi" })
namespace LazyNameApi;

model Node {
  next?: Node;
}

model UserNode {
  next?: UserNode;
}

@route("/nodes")
interface Nodes {
  @route("/user") @post getUser(@body body: Node): Node;
  @route("/all") @post get(@body body: UserNode): UserNode;
}
`;

const multipartSpec = `
import "@typespec/http";
using TypeSpec.Http;

@service(#{ title: "UploadApi" })
namespace UploadApi;

model UploadResult { id: string; size: int32; }

@route("/upload")
interface Uploads {
  @route("/single") @post single(
    @multipartBody body: {
      name: HttpPart<string>;
      file: HttpPart<File>;
    },
  ): UploadResult;

  @route("/multi") @post multi(
    @multipartBody body: {
      label: HttpPart<string>;
      files: HttpPart<File>[];
    },
  ): UploadResult;

  @route("/optional") @post optional(
    @multipartBody body: {
      name: HttpPart<string>;
      description?: HttpPart<string>;
    },
  ): UploadResult;
}
`;

const multipartArrayPartSpec = `
import "@typespec/http";
using TypeSpec.Http;

@service(#{ title: "MultipartArrayApi" })
namespace MultipartArrayApi;

model Address { city: string; }

@route("/upload")
@post
op upload(
  @multipartBody body: {
    previousAddresses: HttpPart<Address[]>;
    addresses: HttpPart<Address>[];
  },
): void;
`;

const contentTypeSpec = `
import "@typespec/http";
using TypeSpec.Http;

@service(#{ title: "ContentTypeApi" })
namespace ContentTypeApi;

model JsonItem { id: string; payload: bytes; }
model FormItem { name: string; }
model FlexibleItem { count: int32; enabled: boolean; }
model UploadResult { id: string; }

@route("/items")
interface Items {
  @route("/json") @post createJson(@body body: JsonItem): JsonItem;

  @route("/form") @post createForm(
    @header contentType: "application/x-www-form-urlencoded",
    @body body: FormItem,
  ): FormItem;

  @route("/text") @post createText(
    @header contentType: "text/plain",
    @body body: string,
  ): string;

  @route("/bytes") @post createBytes(
    @header contentType: "application/octet-stream",
    @body body: bytes,
  ): bytes;

  @route("/mixed") @post createMixed(
    @header contentType: "application/json" | "application/x-www-form-urlencoded",
    @body body: FlexibleItem,
  ): FlexibleItem;

  @route("/upload") @post upload(
    @multipartBody body: {
      name: HttpPart<string>;
      file: HttpPart<File>;
    },
  ): UploadResult;
}
`;

const parameterWireFormatSpec = `
import "@typespec/http";
using TypeSpec.Http;

@service(#{ title: "WireFormatApi" })
namespace WireFormatApi;

@route("/items")
interface Items {
  @route("/{itemId}/{pathValues}") @get read(
    @path("itemId") localId: string,
    @path pathValues: string[],
    @query(#{ name: "compact", explode: false }) compactValues: string[],
    @query(#{ name: "expanded", explode: true }) expandedValues: string[],
    @header("x-values") headerValues: string[],
    @cookie("choices") cookieValues: string[],
  ): void;

  @route("/labels{.labelValues*}") @get readLabels(
    @path labelValues: string[],
  ): void;

  @route("/matrices{;matrixValues*}") @get readMatrices(
    @path matrixValues: string[],
  ): void;
}
`;

const renamedPathParameterSpec = `
import "@typespec/http";
using TypeSpec.Http;

@service(#{ title: "RenamedPathApi" })
namespace RenamedPathApi;

@route("/items/{item-id}")
@get op read(@path("item-id") itemId: int32): string;
`;

const integerRangesSpec = `
import "@typespec/http";
using TypeSpec.Http;

@service(#{ title: "IntegerRangesApi" })
namespace IntegerRangesApi;

model IntegerPayload {
  int8Value: int8;
  uint8Value: uint8;
  int16Value: int16;
  uint16Value: uint16;
  int32Value: int32;
  uint32Value: uint32;
  int64Value: int64;
  uint64Value: uint64;
  integerValue: integer;
  safeValue: safeint;
}

@route("/integers")
interface Integers {
  @post create(@body body: IntegerPayload): void;
  @get read(@query value: uint32): void;
}
`;

const discriminatedUnionSpec = `
import "@typespec/http";
using TypeSpec.Http;

@service(#{ title: "ShapesApi" })
namespace ShapesApi;

model Circle { kind: "circle"; radius: float64; }
model Square { kind: "square"; size: float64; }

union Shape { circle: Circle, square: Square }

model Cat { species: "cat"; meows: boolean; }
model Dog { species: "dog"; barks: boolean; }
union Pet { cat: Cat, dog: Dog }

model Left { value: string; }
model Right { count: int32; }
union Mixed { left: Left, right: Right }

@route("/shapes")
interface Shapes {
  @post create(@body body: Shape): Circle;
  @route("/pets") @post adopt(@body body: Pet): Cat;
  @route("/mixed") @post mix(@body body: Mixed): Left;
}
`;

const prototypeDiscriminatorSpec = `
import "@typespec/http";
using TypeSpec.Http;

@service(#{ title: "PrototypeDiscriminatorApi" })
namespace PrototypeDiscriminatorApi;

model PrototypeVariant { kind: "__proto__"; value: string; }
model ConstructorVariant { kind: "constructor"; count: int32; }
union SpecialValue { prototype: PrototypeVariant, constructor: ConstructorVariant }

@route("/special")
@post op create(@body body: SpecialValue): void;
`;

const inheritedBodyImportSpec = `
import "@typespec/http";
using TypeSpec.Http;

@service(#{ title: "InheritedBodyImportApi" })
namespace InheritedBodyImportApi;

model Payload {
  code: string;
}

model Base {
  payload: Payload;
}

model CreateRequest extends Base {
  name: string;
}

model CreateResponse {
  id: string;
}

@route("/items")
interface Items {
  @post create(@body body: CreateRequest): CreateResponse;
}
`;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("input decoding", () => {
  test("optional query and header params", () => {
    const r = compileFixture("params", paramsSpec);

    expect(r.readFile("params-api", "server-operations.ts")).toMatchSnapshot();
    expect(r.readFile("params-api", "server.ts")).toMatchSnapshot();
  });

  test("validation decorators become runtime validators", () => {
    const r = compileFixture("validations", validationSpec);

    expect(r.readFile("validation-api", "server-operations.ts")).toMatchSnapshot();
  });

  test("path + query + body combined", () => {
    const r = compileFixture("combined", combinedSpec);

    expect(r.readFile("combined-api", "server-operations.ts")).toMatchSnapshot();
  });

  test("cookie parameters", () => {
    const r = compileFixture("cookies", cookieSpec);

    expect(r.readFile("cookie-api", "server-operations.ts")).toMatchSnapshot();
    expect(r.readFile("cookie-api", "server.ts")).toMatchSnapshot();
  });

  test("recursive model uses Decoders.lazy", () => {
    const r = compileFixture("recursive", recursiveSpec);

    expect(r.readFile("tree-api", "server-operations.ts")).toMatchSnapshot();
  });

  test("same-named recursive operations use module-unique lazy declarations", () => {
    const r = compileFixture("shared-recursive", sharedRecursiveSpec);
    const operations = r.readFile("shared-tree-api", "server-operations.ts");
    const declarations = operations.match(/const (_lazy[^:]+): Decoder<TreeNode>/g);

    expect(declarations).toHaveLength(2);
    expect(new Set(declarations).size).toBe(2);
    r.typecheck("shared-tree-api");
  });

  test("lazy decoder identifiers preserve operation and model boundaries", () => {
    const r = compileFixture("lazy-name-collisions", collidingLazyDecoderNamesSpec);
    const operations = r.readFile("lazy-name-api", "server-operations.ts");

    expect(operations.match(/const _lazy[^:]+: Decoder<Node>/g)).toHaveLength(1);
    expect(operations.match(/const _lazy[^:]+: Decoder<UserNode>/g)).toHaveLength(1);
    r.typecheck("lazy-name-api");
  });

  test("multipart body with file, multi-valued, and optional parts", () => {
    const r = compileFixture("multipart", multipartSpec);

    expect(r.readFile("upload-api", "server-operations.ts")).toMatchSnapshot();
    expect(r.readFile("upload-api", "server.ts")).toMatchSnapshot();
  });

  test("typechecks single array-valued and repeated multipart parts", () => {
    const r = compileFixture("multipart-array-parts", multipartArrayPartSpec);
    const operations = r.readFile("multipart-array-api", "server-operations.ts");
    const descriptorFor = (property: string): string => {
      const propertyIndex = operations.indexOf(`property: ${JSON.stringify(property)}`);
      const start = operations.lastIndexOf("\n      {", propertyIndex);
      const end = operations.indexOf("\n      },", propertyIndex);
      if (propertyIndex === -1 || start === -1 || end === -1) {
        throw new Error(`Could not find generated multipart descriptor for ${property}.`);
      }
      return operations.slice(start, end);
    };

    const arrayPayload = descriptorFor("previousAddresses");
    expect(arrayPayload).toContain("decoder: Decoders.strictArray(");
    expect(arrayPayload).not.toContain("multi: true");

    const repeatedParts = descriptorFor("addresses");
    expect(repeatedParts).toContain("decoder: Decoders.object<Address>(");
    expect(repeatedParts).toContain("multi: true");
    r.typecheck("multipart-array-api");
  });

  test("tagged unions dispatch via Decoders.discriminated", () => {
    const r = compileFixture("discriminated-union", discriminatedUnionSpec);
    const operations = r.readFile("shapes-api", "server-operations.ts");

    // Dispatch field is inferred from a common required literal field
    // present in every variant with distinct values.
    expect(operations).toContain(`Decoders.discriminated<Shape>("kind"`);
    expect(operations).toContain(`Decoders.discriminated<Pet>("species"`);
    // No shared literal field — falls back to the linear-scan union decoder.
    expect(operations).toContain("Decoders.union<Mixed>(");
    expect(operations).not.toContain("Decoders.union<Shape>(");
    expect(operations).not.toContain("Decoders.union<Pet>(");
    expect(operations).toMatchSnapshot();
    r.typecheck("shapes-api");
  });

  test("prototype-named discriminator variants emit safe own properties", () => {
    const r = compileFixture("prototype-discriminator", prototypeDiscriminatorSpec);
    const operations = r.readFile("prototype-discriminator-api", "server-operations.ts");

    expect(operations).toContain('["__proto__"]: Decoders.object<PrototypeVariant>');
    expect(operations).toContain("constructor: Decoders.object<ConstructorVariant>");
    r.typecheck("prototype-discriminator-api");
  });

  test("inherited body properties pull in imported model types", () => {
    const r = compileFixture("inherited-body-import", inheritedBodyImportSpec);

    r.typecheck("inherited-body-import-api");
  });

  test("emits declared body content types for each operation", () => {
    const r = compileFixture("content-types", contentTypeSpec);
    const operations = r.readFile("content-type-api", "server-operations.ts");

    // Every body-bearing operation carries its declared media types so the
    // runtime can reject mismatched Content-Type with a 415 before parsing.
    expect(operations).toContain(`contentTypes: ["application/json"]`);
    expect(operations).toContain(`contentTypes: ["application/x-www-form-urlencoded"]`);
    expect(operations).toContain(`contentTypes: ["text/plain"]`);
    expect(operations).toContain(`contentTypes: ["application/octet-stream"]`);
    expect(operations).toContain(`contentTypes: ["multipart/form-data"]`);
    expect(operations).toContain("text: Decoders.string");
    expect(operations).toContain("binary: Decoders.bytes");
    expect(operations).toContain("payload: Decoders.strictBytes");
    expect(operations).toContain("json: Decoders.object<FlexibleItem>");
    expect(operations).toContain("form: Decoders.object<FlexibleItem>");
    expect(operations).toContain("count: Decoders.strictInteger");
    expect(operations).toContain("count: Decoders.integer");
    expect(operations).toContain("enabled: Decoders.strictBoolean");
    expect(operations).toContain("enabled: Decoders.boolean");
    expect(operations).toContain("mediaType: true");
    expect(operations).toContain('decodeRequestInputAndBody<{ contentType: "text/plain" }');
    expect(operations).toContain(
      'decodeRequestInputAndBody<{ contentType: "application/octet-stream" }',
    );
    r.typecheck("content-type-api");
  });

  test("emits wire names and array serialization options", () => {
    const r = compileFixture("parameter-wire-formats", parameterWireFormatSpec);
    const operations = r.readFile("wire-format-api", "server-operations.ts");

    expect(operations).toContain('RequestDecoders.path("itemId", Decoders.string)');
    expect(operations).toContain(
      'RequestDecoders.path("pathValues", Decoders.array(Decoders.string), { array: true })',
    );
    expect(operations).toContain(
      `RequestDecoders.path("labelValues", Decoders.array(Decoders.string), {
    array: true,
    arraySeparator: ".",
  })`,
    );
    expect(operations).toContain(
      `RequestDecoders.path("matrixValues", Decoders.array(Decoders.string), {
    array: true,
    arraySeparator: ";matrixValues=",
  })`,
    );
    expect(operations).toContain("explode: false");
    expect(operations).toContain("explode: true");
    expect(operations).toContain(
      'RequestDecoders.header("x-values", Decoders.array(Decoders.string), { array: true })',
    );
    expect(operations).toContain(
      'RequestDecoders.cookie("choices", Decoders.array(Decoders.string), { array: true })',
    );
    expect(operations).toContain("(localId, pathValues, compactValues");
    r.typecheck("wire-format-api");
  });

  test("routes renamed path parameters and binds them to the handler input", async () => {
    const r = compileFixture("renamed-path-parameter", renamedPathParameterSpec);
    r.typecheck("renamed-path-api");

    const { createRenamedPathApiServerRouter } = await import(
      `${r.outputDir}/renamed-path-api/server-router.ts`
    );
    let handlerInput: { itemId: number } | undefined;
    let matchedPathParams: Record<string, string> | undefined;
    const router = createRenamedPathApiServerRouter({
      read(input: { itemId: number }, context: { match: { pathParams: Record<string, string> } }) {
        handlerInput = input;
        matchedPathParams = context.match.pathParams;
        return `item:${input.itemId}`;
      },
    });

    const response = await router.handle(new Request("http://localhost/items/123"));

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("item:123");
    expect(matchedPathParams).toEqual({ "item-id": "123" });
    expect(handlerInput).toEqual({ itemId: 123 });
  });

  test("emits intrinsic integer shape and range validation", () => {
    const r = compileFixture("integer-ranges", integerRangesSpec);
    const operations = r.readFile("integer-ranges-api", "server-operations.ts");

    expect(operations).toContain("int8Value: Decoders.strictInteger.validate(");
    expect(operations).toContain("uint32Value: Decoders.strictInteger.validate(");
    expect(operations).toContain("Validators.minValue(-128)");
    expect(operations).toContain("Validators.maxValue(4294967295)");
    expect(operations).toContain("Validators.minValue(-9223372036854775808n)");
    expect(operations).toContain("Validators.maxValue(9223372036854775807n)");
    expect(operations).toContain("Validators.maxValue(18446744073709551615n)");
    expect(operations).toContain("integerValue: Decoders.strictInteger");
    expect(operations).toContain("safeValue: Decoders.strictSafeInteger");
    expect(operations).toContain(
      "Decoders.integer.validate(Validators.minValue(0), Validators.maxValue(4294967295))",
    );
    r.typecheck("integer-ranges-api");
  });
});
