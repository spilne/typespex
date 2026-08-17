import { McpToolError } from "@typespex/mcp-server";
import type { McpToolContext } from "@typespex/mcp-server";
import type {
  HttpAuthCredentials,
  HttpAuthScheme,
  HttpBridgeOperation,
  McpHttpAuthProvider,
} from "./contracts.js";

export function composeHttpAuthProviders(
  ...providers: readonly McpHttpAuthProvider[]
): McpHttpAuthProvider {
  return async (request) => {
    for (const provider of providers) {
      const credentials = await provider(request);
      if (credentials) return credentials;
    }
    return undefined;
  };
}

export type StaticHttpCredential = string | { readonly value: string; readonly prefix?: string };

/** Creates a provider keyed by generated TypeSpec auth scheme IDs. */
export function staticHttpAuthProvider(
  credentials: Readonly<Record<string, StaticHttpCredential | undefined>>,
): McpHttpAuthProvider {
  return ({ alternatives }) => {
    let permitsNoAuth = false;
    for (const alternative of alternatives) {
      if (alternative.noAuth) {
        permitsNoAuth = true;
        continue;
      }
      const output: MutableCredentials = { headers: {}, query: {}, cookies: {} };
      let complete = true;
      for (const scheme of alternative.schemes) {
        const configured = Object.hasOwn(credentials, scheme.id)
          ? credentials[scheme.id]
          : undefined;
        if (!configured) {
          complete = false;
          break;
        }
        applyStaticCredential(output, scheme, configured);
      }
      if (complete) return compactCredentials(output);
    }
    return permitsNoAuth ? {} : undefined;
  };
}

export function environmentHttpAuthProvider(
  variables: Readonly<Record<string, string>>,
  environment: Readonly<Record<string, string | undefined>> = runtimeEnvironment(),
): McpHttpAuthProvider {
  const credentials: Record<string, string | undefined> = {};
  for (const [scheme, variable] of Object.entries(variables))
    credentials[scheme] = environment[variable];
  return staticHttpAuthProvider(credentials);
}

/** Explicit opt-in to forwarding a verified inbound bearer token upstream. */
export function forwardInboundBearerAuthProvider(): McpHttpAuthProvider {
  return ({ alternatives, context }) => {
    if (!context.authInfo?.token) return undefined;
    const acceptsBearer = alternatives.some(
      (alternative) =>
        !alternative.noAuth &&
        alternative.schemes.length === 1 &&
        (alternative.schemes[0]?.type === "oauth2" ||
          alternative.schemes[0]?.type === "openIdConnect" ||
          (alternative.schemes[0]?.type === "http" &&
            alternative.schemes[0].scheme.toLowerCase() === "bearer")),
    );
    return acceptsBearer
      ? { headers: { Authorization: `Bearer ${context.authInfo.token}` } }
      : undefined;
  };
}

export async function resolveCredentials(
  operation: HttpBridgeOperation,
  input: unknown,
  context: McpToolContext,
  provider: McpHttpAuthProvider | undefined,
): Promise<HttpAuthCredentials | undefined> {
  const alternatives = operation.auth ?? [];
  if (alternatives.length === 0) return undefined;
  const noAuth = alternatives.some((alternative) => alternative.noAuth);
  if (!provider) {
    if (noAuth) return undefined;
    throw new McpToolError(`Upstream authentication is required for ${operation.id}.`);
  }
  const credentials = await provider({ operation, alternatives, input, context });
  if ((!credentials || !hasCredentialValue(credentials)) && !noAuth) {
    throw new McpToolError(`No usable upstream credential is available for ${operation.id}.`);
  }
  return credentials;
}

function hasCredentialValue(credentials: HttpAuthCredentials): boolean {
  return [credentials.headers, credentials.query, credentials.cookies].some(
    (values) => values && Object.keys(values).length > 0,
  );
}

interface MutableCredentials {
  headers: Record<string, string>;
  query: Record<string, string>;
  cookies: Record<string, string>;
}

function applyStaticCredential(
  output: MutableCredentials,
  scheme: HttpAuthScheme,
  configured: StaticHttpCredential,
): void {
  const value = typeof configured === "string" ? configured : configured.value;
  const prefix = typeof configured === "string" ? undefined : configured.prefix;
  if (scheme.type === "apiKey") {
    output[
      scheme.location === "header" ? "headers" : scheme.location === "query" ? "query" : "cookies"
    ][scheme.name] = value;
    return;
  }
  const defaultPrefix =
    scheme.type === "http" && scheme.scheme.toLowerCase() !== "bearer" ? scheme.scheme : "Bearer";
  output.headers.Authorization = `${prefix ?? defaultPrefix} ${value}`;
}

function compactCredentials(credentials: MutableCredentials): HttpAuthCredentials {
  return {
    ...(Object.keys(credentials.headers).length > 0 ? { headers: credentials.headers } : {}),
    ...(Object.keys(credentials.query).length > 0 ? { query: credentials.query } : {}),
    ...(Object.keys(credentials.cookies).length > 0 ? { cookies: credentials.cookies } : {}),
  };
}

function runtimeEnvironment(): Readonly<Record<string, string | undefined>> {
  return (
    (
      globalThis as typeof globalThis & {
        process?: { readonly env?: Readonly<Record<string, string | undefined>> };
      }
    ).process?.env ?? {}
  );
}
