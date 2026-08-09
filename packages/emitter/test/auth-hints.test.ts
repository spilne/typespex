import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { buildEmitter, cleanupFixtures, compileFixture } from "./compile-fixture.js";

afterAll(cleanupFixtures);
beforeAll(buildEmitter);

const authSpec = `
import "@typespec/http";
using TypeSpec.Http;

alias ScopedOAuth<Scopes extends string[]> = OAuth2Auth<
  [
    {
      type: OAuth2FlowType.authorizationCode;
      authorizationUrl: "https://example.test/authorize";
      tokenUrl: "https://example.test/token";
      refreshUrl: "https://example.test/refresh";
    },
    {
      type: OAuth2FlowType.implicit;
      authorizationUrl: "https://example.test/implicit";
    },
    {
      type: OAuth2FlowType.password;
      tokenUrl: "https://example.test/password";
    },
    {
      type: OAuth2FlowType.clientCredentials;
      tokenUrl: "https://example.test/client";
    }
  ],
  Scopes
>;

@service
@useAuth(BearerAuth)
namespace AuthApi {
  @route("/inherited") @get
  op inherited(): void;

  @route("/basic") @useAuth(BasicAuth)
  interface BasicArea {
    @get op basic(): void;
  }

  @route("/api-key") @get
  @useAuth(ApiKeyAuth<ApiKeyLocation.header, "x-api-key">)
  op apiKey(): void;

  @route("/oauth") @get @useAuth(ScopedOAuth<["read", "write"]>)
  op oauth(): void;

  @route("/optional") @get @useAuth(BearerAuth | NoAuth)
  op optional(): void;

  @route("/combined") @get
  @useAuth([BasicAuth, ApiKeyAuth<ApiKeyLocation.query, "api_key">])
  op combined(): void;
}
`;

describe("TypeSpec authentication hints", () => {
  test("emits resolved service auth, overrides, alternatives, groups, and scopes", () => {
    const result = compileFixture("auth-hints", authSpec);
    const hints = result.readFile("auth-api", "server-hints.ts");
    const operations = result.readFile("auth-api", "server-operations.ts");

    expect(hints).toContain("export interface TypeSpecAuthentication");
    expect(hints).toContain("export type TypeSpecAuthScheme");
    expect(hints).toContain('createHintKey<TypeSpecAuthentication>("TypeSpec.Http.useAuth")');
    expect(operations.match(/ServerHints\.typeSpecAuthHint/g) ?? []).toHaveLength(6);
    expect(operations).toContain('service: { name: "AuthApi", hints: emptyHints() }');

    expect(operationMetadata(operations, "AuthApi.inherited")).toContain(
      normalize(
        '{ options: [{ schemes: [{ id: "BearerAuth", type: "http", scheme: "Bearer" }] }] }',
      ),
    );
    expect(operationMetadata(operations, "BasicArea.basic")).toContain(
      normalize('{ options: [{ schemes: [{ id: "BasicAuth", type: "http", scheme: "Basic" }] }] }'),
    );
    expect(operationMetadata(operations, "AuthApi.apiKey")).toContain(
      normalize('type: "apiKey", in: "header", name: "x-api-key"'),
    );
    expect(operationMetadata(operations, "AuthApi.oauth")).toContain(normalize('type: "oauth2"'));
    expect(operationMetadata(operations, "AuthApi.oauth")).toContain(
      normalize('scopes: [{ value: "read" }, { value: "write" }]'),
    );
    expect(operationMetadata(operations, "AuthApi.oauth")).toContain(
      normalize(
        'type: "password", scopes: [{ value: "read" }, { value: "write" }], tokenUrl: "https://example.test/password"',
      ),
    );
    expect(operationMetadata(operations, "AuthApi.oauth")).toContain(
      normalize(
        'type: "clientCredentials", scopes: [{ value: "read" }, { value: "write" }], tokenUrl: "https://example.test/client"',
      ),
    );
    const optional = operationMetadata(operations, "AuthApi.optional");
    expect(optional).toContain(normalize('schemes: [{ id: "NoAuth", type: "noAuth" }]'));
    expect(optional).toContain(normalize('{ id: "BearerAuth", type: "http", scheme: "Bearer" }'));
    expect(optional.match(/schemes:/g) ?? []).toHaveLength(2);
    const combined = operationMetadata(operations, "AuthApi.combined");
    expect(combined).toContain(normalize('{ id: "BasicAuth", type: "http", scheme: "Basic" }'));
    expect(combined).toContain(
      normalize('{ id: "ApiKeyAuth", type: "apiKey", in: "query", name: "api_key" }'),
    );
    expect(combined.match(/schemes:/g) ?? []).toHaveLength(1);

    result.typecheck("auth-api", {
      "auth-middleware.ts": `
        import type { MatchedRequestContext, Middleware } from "@typespex/runtime/server";
        import { typeSpecAuthHint, type TypeSpecAuthentication } from "./server-hints.js";

        export const authMiddleware: Middleware<MatchedRequestContext> = (next) => async (ctx) => {
          const auth: TypeSpecAuthentication | undefined =
            ctx.match.endpoint.operation.hints.get(typeSpecAuthHint);
          const acceptsBearer = auth?.options.some((option) =>
            option.schemes.some(
              (scheme) => scheme.type === "http" && scheme.scheme.toLowerCase() === "bearer",
            ),
          );
          if (acceptsBearer && !ctx.request.headers.has("authorization")) {
            return new Response("Unauthorized", { status: 401 });
          }
          return next(ctx);
        };
      `,
    });
  });

  test("does not emit the authentication contract for an unauthenticated service", () => {
    const result = compileFixture(
      "no-auth-hints",
      `
        import "@typespec/http";
        using TypeSpec.Http;
        @service namespace PublicApi {
          @route("/health") @get op health(): void;
        }
      `,
    );

    expect(result.readFile("public-api", "server-hints.ts")).not.toContain("typeSpecAuthHint");
    expect(result.readFile("public-api", "server-operations.ts")).not.toContain("typeSpecAuthHint");
  });
});

function operationMetadata(source: string, operationId: string): string {
  const start = source.indexOf(`operationId: ${JSON.stringify(operationId)}`);
  if (start < 0) throw new Error(`Operation ${operationId} was not emitted.`);
  const end = source.indexOf("\n      },", start);
  if (end < 0) throw new Error(`Operation metadata for ${operationId} was not terminated.`);
  return normalize(source.slice(start, end));
}

function normalize(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}
