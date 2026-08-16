import type { MatchedRequestContext, Middleware } from "@typespex/http-server";
import {
  typeSpecAuthHint,
  type TypeSpecAuthentication,
} from "./generated/pet-store/server-hints.js";

const BEARER_CREDENTIAL = /^Bearer\s+\S+$/i;

/** Example application policy for the authentication requirements emitted from TypeSpec. */
export const bearerAuthMiddleware: Middleware<MatchedRequestContext> = (next) => async (ctx) => {
  const authentication = ctx.match?.endpoint.operation.hints.get(typeSpecAuthHint);
  if (!authentication || requestSatisfies(authentication, ctx.request)) {
    return next(ctx);
  }

  return Response.json(
    { code: "UNAUTHORIZED", message: "A bearer token is required." },
    { status: 401 },
  );
};

function requestSatisfies(authentication: TypeSpecAuthentication, request: Request): boolean {
  return authentication.options.some(
    (option) =>
      option.schemes.length > 0 &&
      option.schemes.every((scheme) => {
        if (scheme.type === "noAuth") return true;
        if (scheme.type !== "http" || scheme.scheme.toLowerCase() !== "bearer") return false;
        return BEARER_CREDENTIAL.test(request.headers.get("authorization") ?? "");
      }),
  );
}
