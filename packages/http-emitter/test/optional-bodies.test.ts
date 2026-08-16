import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { buildEmitter, cleanupFixtures, compileFixture } from "./compile-fixture.js";

afterAll(cleanupFixtures);
beforeAll(buildEmitter);

const optionalBodySpec = `
import "@typespec/http";
using TypeSpec.Http;

@service(#{ title: "OptionalBodyApi" })
namespace OptionalBodyApi;

model Payload {
  value: string;
  count?: int32;
}

@route("/only")
@post op only(@body body?: Payload): Payload;

@route("/flattened")
@post op flattened(@query trace: string, @body body?: Payload): Payload;

@route("/wrapped")
@post op wrapped(@query trace: string, @body body?: Payload[]): Payload;

@route("/multipart-only")
@post op multipartOnly(@multipartBody body?: {
  description: HttpPart<string>;
  attachment: HttpPart<bytes>;
}): void;

@route("/multipart-flattened")
@post op multipartFlattened(
  @query trace: string,
  @multipartBody body?: {
    description: HttpPart<string>;
    attachment: HttpPart<bytes>;
  },
): void;
`;

describe("optional body handler types", () => {
  test("marks regular and multipart body input as optional", () => {
    const r = compileFixture("optional-body-types", optionalBodySpec);
    const server = r.readFile("optional-body-api", "server.ts");
    const operations = r.readFile("optional-body-api", "server-operations.ts");
    const router = r.readFile("optional-body-api", "server-router.ts");

    expect(server).toContain("readonly only: OperationHandler<Payload | undefined, Payload, Ctx>");
    expect(server).toContain("readonly flattened: OperationHandler<");
    expect(server).toContain("{ trace: string; value?: string; count?: number },");
    expect(server).toContain(
      "readonly wrapped: OperationHandler<{ trace: string; body?: Payload[] }, Payload, Ctx>",
    );
    expect(server).toContain("readonly multipartOnly: OperationHandler<");
    expect(server).toContain("{ description: string; attachment: Uint8Array } | undefined,");
    expect(server).toContain("readonly multipartFlattened: OperationHandler<");
    expect(server).toContain("{ trace: string; description?: string; attachment?: Uint8Array },");
    expect(operations.match(/optional: true/g)).toHaveLength(5);
    expect(router).toContain("): ComposableHttpRouter {");
    r.typecheck("optional-body-api", {
      "review-type-assertions.ts": `
import type {
  BodyDecodeError,
  BodyDecodeOptions,
  BodyDecoderMap,
  ComposableHttpRouter,
  Either,
  HttpRouter,
  RequestDecoder,
} from "@typespex/http-server";
import { decodeRequestInputAndBody } from "@typespex/http-server";
import { createOptionalBodyApiServerRouter } from "./server-router.js";

declare const requestDecoder: RequestDecoder<{ trace: string }>;
declare const bodyDecoder: BodyDecoderMap<{ body: string }>;
declare const request: Request;
declare const options: BodyDecodeOptions;

const required = decodeRequestInputAndBody(requestDecoder, bodyDecoder, request, {});
const requiredType: Promise<
  Either<BodyDecodeError, { trace: string } & { body: string }>
> = required;

const optional = decodeRequestInputAndBody(
  requestDecoder,
  bodyDecoder,
  request,
  {},
  { optional: true },
);
const optionalType: Promise<
  Either<BodyDecodeError, { trace: string } & Partial<{ body: string }>>
> = optional;
// @ts-expect-error An absent optional body cannot provide required body fields.
const unsoundOptionalType: Promise<
  Either<BodyDecodeError, { trace: string } & { body: string }>
> = optional;

const dynamic = decodeRequestInputAndBody(requestDecoder, bodyDecoder, request, {}, options);
const dynamicType: Promise<
  Either<BodyDecodeError, { trace: string } & Partial<{ body: string }>>
> = dynamic;

const legacyRouter: HttpRouter = {
  handle: async () => new Response(),
};
type GeneratedRouter = ReturnType<typeof createOptionalBodyApiServerRouter>;
declare const generatedRouter: GeneratedRouter;
const composableRouter: ComposableHttpRouter = generatedRouter;
// @ts-expect-error A legacy router does not guarantee tryHandle semantics.
const invalidComposableRouter: ComposableHttpRouter = legacyRouter;

void requiredType;
void optionalType;
void unsoundOptionalType;
void dynamicType;
void composableRouter;
void invalidComposableRouter;
`,
    });
  });
});
