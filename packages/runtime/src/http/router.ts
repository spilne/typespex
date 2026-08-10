import { isLeft } from "../core/either.js";
import { HttpError } from "../errors.js";
import { createContextMap } from "../core/context.js";
import { type HttpApp, type Middleware } from "../core/middleware.js";
import type { OperationHandler } from "../core/handler.js";
import type { RouteMatcher } from "../matcher.js";
import { createRegexMatcher } from "../match-regex.js";
import {
  enforceRequestBodyLimit,
  type RequestBodyLimit,
  resolveRequestBodyLimit,
} from "./body-limit.js";
import type { RequestContext } from "./context.js";
import type { MatchedEndpoint } from "./metadata.js";
import type { ServerOperation } from "./operation.js";

/** Extracts the request pathname without allocating a `URL` instance. */
function extractPathname(url: string): string {
  const protoEnd = url.indexOf("://");
  if (protoEnd !== -1) {
    const pathStart = url.indexOf("/", protoEnd + 3);
    if (pathStart === -1) return "/";
    const queryStart = url.indexOf("?", pathStart);
    return queryStart === -1 ? url.substring(pathStart) : url.substring(pathStart, queryStart);
  }
  const queryStart = url.indexOf("?");
  return queryStart === -1 ? url : url.substring(0, queryStart);
}

/** Combines middleware into one wrapper applied around the core app. */
function combineMiddleware<Ctx extends RequestContext>(
  middleware: ReadonlyArray<Middleware<Ctx>>,
): Middleware<Ctx> {
  return middleware.reduceRight<Middleware<Ctx>>(
    (current, mw) => (app) => mw(current(app)),
    (app) => app,
  );
}

/** Creates the app for one route — decode, handle, encode. No Map lookup. */
function createRouteApp<I, R, Ctx extends RequestContext>(
  route: RouteBinding<I, R, Ctx>,
  notFound: HttpInterpreterOptions<Ctx>["notFound"],
): HttpApp<Ctx> {
  return async (ctx: Ctx) => {
    if (!ctx.match) {
      if (notFound) return notFound(ctx);
      return Response.json({ error: "Not Found" }, { status: 404 });
    }

    const decoded = route.operation.decodeInput(ctx.request, ctx.match.pathParams);
    const result = decoded instanceof Promise ? await decoded : decoded;
    if (isLeft(result)) {
      return result.left.toResponse();
    }

    const handled = await route.handler(result.right, ctx);
    return route.operation.encodeResult(handled);
  };
}

function createDefaultContext(request: Request, match?: MatchedEndpoint): RequestContext {
  return { request, match, state: createContextMap() };
}

/** Not-found app — used when no route matches. */
function createNotFoundApp<Ctx extends RequestContext>(
  options: HttpInterpreterOptions<Ctx>,
): HttpApp<Ctx> {
  return async (ctx: Ctx) => {
    if (options.notFound) return options.notFound(ctx);
    return Response.json({ error: "Not Found" }, { status: 404 });
  };
}

/** Options for the HTTP interpreter produced by `createHttpRouter`. */
export interface HttpInterpreterOptions<Ctx extends RequestContext> {
  readonly middleware?: ReadonlyArray<Middleware<Ctx>>;
  readonly createContext?: (request: Request, match?: MatchedEndpoint) => Promise<Ctx> | Ctx;
  readonly onUnhandledError?: (error: unknown, context: Ctx) => Promise<Response> | Response;
  readonly notFound?: (context: Ctx) => Promise<Response> | Response;
  /**
   * Maximum streamed request-body bytes. Defaults to 10 MiB. Use a
   * non-negative safe integer to override the limit, or `false` to disable it.
   * `handle` applies known Content-Length limits before matched or not-found
   * middleware; an unmatched `tryHandle` request remains untouched.
   */
  readonly maxRequestBodyBytes?: RequestBodyLimit;
}

/** HTTP request handler accepted by the runtime adapters. */
export interface HttpRouter {
  /** Handles a request, including configured middleware and not-found handling. */
  handle(request: Request): Promise<Response>;

  /**
   * Handles a request only when one of the router's operations matches it.
   *
   * `undefined` means that no route matched. A `Response`, including a 404
   * response, is always the result of a matched operation.
   *
   * This member is optional for compatibility with custom routers that only
   * implement `handle`. APIs that require fallthrough use
   * `ComposableHttpRouter` instead.
   */
  tryHandle?(request: Request): Promise<Response | undefined>;
}

/** Router that can distinguish an unmatched request from a matched response. */
export interface ComposableHttpRouter extends HttpRouter {
  tryHandle(request: Request): Promise<Response | undefined>;
}

/** Binds one generated server operation to its implementation handler. */
export interface RouteBinding<I, R, Ctx extends RequestContext> {
  readonly operation: ServerOperation<I, R>;
  readonly handler: OperationHandler<I, R, Ctx>;
}

/** Convenience helper for constructing a typed `RouteBinding`. */
export function bindRoute<I, R, Ctx extends RequestContext>(
  operation: ServerOperation<I, R>,
  handler: OperationHandler<I, R, Ctx>,
): RouteBinding<I, R, Ctx> {
  return { operation, handler };
}

/** Creates an HTTP router that matches requests, decodes input, runs middleware, and encodes responses. */
export function createHttpRouter<Ctx extends RequestContext>(
  routes: ReadonlyArray<RouteBinding<any, any, Ctx>>,
  options: HttpInterpreterOptions<Ctx> = {},
  matcher?: RouteMatcher<RouteBinding<any, any, Ctx>>,
): ComposableHttpRouter {
  const middleware = options.middleware ?? [];
  const middlewareChain = combineMiddleware(middleware);
  const maxRequestBodyBytes = resolveRequestBodyLimit(options.maxRequestBodyBytes);

  // Build a middleware-wrapped app per route — no Map lookup at request time
  const wrappedApps = new Map<RouteBinding<any, any, Ctx>, HttpApp<Ctx>>();
  for (const route of routes) {
    wrappedApps.set(route, middlewareChain(createRouteApp(route, options.notFound)));
  }

  // Not-found app also gets middleware (so middleware runs for unmatched requests)
  const notFoundApp = middlewareChain(createNotFoundApp(options));

  const matcherInput = routes.flatMap((binding) => {
    const operation = binding.operation.endpoint.operation;
    if (operation.routePatterns?.length === 0) {
      throw new Error(`Operation ${JSON.stringify(operation.operationId)} has no route patterns.`);
    }
    const routePatterns = operation.routePatterns ?? [operation.routePattern];
    return routePatterns.map((routePattern) => ({
      method: operation.method,
      path: operation.path,
      routePattern,
      selection: operation.routeSelection,
      label: operation.operationId,
      route: binding,
    }));
  });

  const routeMatcher = matcher ?? createRegexMatcher(matcherInput);

  function matchRequest(request: Request) {
    return routeMatcher.match(request.method, extractPathname(request.url), request.headers);
  }

  async function execute(
    request: Request,
    matched: ReturnType<typeof routeMatcher.match>,
  ): Promise<Response> {
    let context: Ctx | undefined;
    try {
      request = enforceRequestBodyLimit(request, maxRequestBodyBytes);
      const match: MatchedEndpoint | undefined = matched
        ? { endpoint: matched.route.operation.endpoint, pathParams: matched.pathParams }
        : undefined;
      context = options.createContext
        ? await options.createContext(request, match)
        : (createDefaultContext(request, match) as Ctx);

      const app = matched ? (wrappedApps.get(matched.route) ?? notFoundApp) : notFoundApp;
      return await app(context);
    } catch (error) {
      if (error instanceof HttpError) {
        return error.toResponse();
      }

      if (options.onUnhandledError && context) {
        return options.onUnhandledError(error, context);
      }

      return new Response("Internal Server Error", { status: 500 });
    }
  }

  return {
    async handle(request: Request): Promise<Response> {
      return execute(request, matchRequest(request));
    },

    async tryHandle(request: Request): Promise<Response | undefined> {
      const matched = matchRequest(request);
      if (!matched) return undefined;
      return execute(request, matched);
    },
  };
}
