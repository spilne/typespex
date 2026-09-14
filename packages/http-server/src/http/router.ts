import { isLeft, type Either } from "../core/either.js";
import { HttpError } from "../errors.js";
import { createContextMap } from "../core/context.js";
import { type HttpApp, type Middleware } from "../core/middleware.js";
import type { OperationHandler } from "../core/handler.js";
import type { RouteMatcher, RoutePattern } from "../matcher.js";
import { normalizeRouteInputs } from "../match-common.js";
import { createNormalizedRegexMatcher } from "../match-regex.js";
import {
  enforceRequestBodyLimit,
  type RequestBodyLimit,
  resolveRequestBodyLimit,
} from "./body-limit.js";
import type { RequestContext } from "./context.js";
import type { MatchedEndpoint } from "./metadata.js";
import type { DecodeError, ServerOperation } from "./operation.js";
import { getSearchParams } from "./query-params.js";

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
  notFound: HttpRouterOptions<Ctx>["notFound"],
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
  options: HttpRouterOptions<Ctx>,
): HttpApp<Ctx> {
  return async (ctx: Ctx) => {
    if (options.notFound) return options.notFound(ctx);
    return Response.json({ error: "Not Found" }, { status: 404 });
  };
}

/** Options for a router produced by `createHttpRouter`. */
export interface HttpRouterOptions<Ctx extends RequestContext> {
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

/** Request facts verified by the hosting HTTP transport. */
export interface HttpRequestTransportInfo {
  /** Original request whose body was framed by the transport; never replace this reference. */
  readonly request: Request;
  /**
   * Exact body length enforced by the transport's HTTP message framing,
   * expressed as a non-negative safe integer.
   * Adapters must not derive this from unverified client headers. Use ordinary
   * handle(request) for synthetic requests and chunked or unbounded bodies.
   */
  readonly verifiedBodyLength: number;
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

const transportHandlers = new WeakMap<
  HttpRouter,
  {
    readonly handle: HttpRouter["handle"];
    readonly handleWithTransport: (
      request: Request,
      transport: HttpRequestTransportInfo,
    ) => Promise<Response>;
    readonly getRoutes?: () => readonly HttpTransportRoute[];
  }
>();

/**
 * A transport's side-effect-free Promise inspector. Non-Promise values report
 * fulfilled and are returned unchanged; fulfilled Promises reveal their value.
 * Rejected Promises must only be awaited, never inspected for their value.
 * @internal
 */
export interface HttpPromiseInspector {
  <T>(value: T | Promise<T>): T | Promise<T>;
  status(value: unknown): "pending" | "fulfilled" | "rejected";
}

/** One unconstrained route that an HTTP transport can dispatch directly. @internal */
export interface HttpTransportRoute {
  readonly method: string;
  readonly pattern: RoutePattern;
  /** The adapter must verify the selected pattern and supply raw path captures. */
  handle(
    request: Request,
    pathParams: Readonly<Record<string, string>>,
    transport?: HttpRequestTransportInfo,
  ): Promise<Response>;
  /**
   * Encodes fulfilled handler results immediately when middleware and custom
   * hooks are absent. Failures are returned as rejected Promises, never thrown.
   */
  dispatch?(
    request: Request,
    pathParams: Readonly<Record<string, string>>,
    peek: HttpPromiseInspector,
    transport?: HttpRequestTransportInfo,
  ): Response | Promise<Response>;
}

/**
 * Adapter registrations for a router with ordinary, unconstrained routing.
 * Custom matchers and router wrappers retain their own dispatch. Each returned
 * handler also checks for a later replacement of the router's handle method.
 * @internal
 */
export function getHttpTransportRoutes(
  router: HttpRouter,
): readonly HttpTransportRoute[] | undefined {
  const registered = transportHandlers.get(router);
  return registered?.handle === router.handle ? registered.getRoutes?.() : undefined;
}

/**
 * Adapter entry point for transport-verified request facts. Only an unchanged
 * router created here can use the shortcut; copies and wrappers keep control
 * through their ordinary handle method.
 *
 * The transport must enforce the supplied length on this original Request.
 * A client-provided Content-Length header alone does not establish that bound.
 */
export function handleRequestWithTransport(
  router: HttpRouter,
  request: Request,
  transport: HttpRequestTransportInfo,
): Promise<Response> {
  const registered = transportHandlers.get(router);
  return registered && registered.handle === router.handle
    ? registered.handleWithTransport(request, transport)
    : router.handle(request);
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
  options: HttpRouterOptions<Ctx> = {},
  matcher?: RouteMatcher<RouteBinding<any, any, Ctx>>,
): ComposableHttpRouter {
  const middleware = options.middleware ?? [];
  const middlewareChain = combineMiddleware(middleware);
  const hasMiddleware = middleware.length > 0;
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

  const normalizedRoutes = matcher ? undefined : normalizeRouteInputs(matcherInput);
  const routeMatcher = matcher ?? createNormalizedRegexMatcher(normalizedRoutes!);
  const needsQuerySelection = matcherInput.some(
    ({ selection }) => (selection?.query?.length ?? 0) > 0,
  );

  function matchRequest(request: Request) {
    return routeMatcher.match(
      request.method,
      extractPathname(request.url),
      request.headers,
      needsQuerySelection ? getSearchParams(request.url) : undefined,
    );
  }

  async function execute(
    request: Request,
    matched: ReturnType<typeof routeMatcher.match>,
    transport?: HttpRequestTransportInfo,
  ): Promise<Response> {
    let context: Ctx | undefined;
    try {
      request = enforceRequestBodyLimit(
        request,
        maxRequestBodyBytes,
        transport?.request === request ? transport.verifiedBodyLength : undefined,
      );
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

      throw error;
    }
  }

  // A native transport can send synchronous results directly. Middleware and
  // custom context/error hooks retain the ordinary Promise-based execution.
  function executeDirect<I, R>(
    request: Request,
    route: RouteBinding<I, R, Ctx>,
    pathParams: Readonly<Record<string, string>>,
    peek: HttpPromiseInspector,
    transport?: HttpRequestTransportInfo,
  ): Response | Promise<Response> {
    let context: Ctx | undefined;
    try {
      // Checking presence avoids evaluating hook getters on successful requests.
      if (hasMiddleware || "createContext" in options || "onUnhandledError" in options) {
        return execute(request, { route, pathParams }, transport);
      }
      request = enforceRequestBodyLimit(
        request,
        maxRequestBodyBytes,
        transport?.request === request ? transport.verifiedBodyLength : undefined,
      );
      context = createDefaultContext(request, {
        endpoint: route.operation.endpoint,
        pathParams,
      }) as Ctx;
      const decoded = route.operation.decodeInput(request, pathParams);
      const response =
        decoded instanceof Promise
          ? finishDecoded(decoded, route, context, peek)
          : finishDirect(decoded, route, context, peek);
      return response instanceof Promise ? catchDirectError(response, context) : response;
    } catch (error) {
      return directFailure(error, context);
    }
  }

  function finishDirect<I, R>(
    result: Either<DecodeError, I>,
    route: RouteBinding<I, R, Ctx>,
    context: Ctx,
    peek: HttpPromiseInspector,
  ): Response | Promise<Response> {
    if (isLeft(result)) return result.left.toResponse();
    const handled = route.handler(result.right, context);
    // Match await's Promise resolution, including constructor and then getters.
    // Pending/rejected Promises go straight to await so those getters run once.
    const pending =
      peek.status(handled) === "fulfilled" ? Promise.resolve(handled) : (handled as Promise<R>);
    return peek.status(pending) === "fulfilled"
      ? route.operation.encodeResult(peek(pending) as R)
      : encodePending(pending, route);
  }

  async function finishDecoded<I, R>(
    decoded: Promise<Either<DecodeError, I>>,
    route: RouteBinding<I, R, Ctx>,
    context: Ctx,
    peek: HttpPromiseInspector,
  ): Promise<Response> {
    return finishDirect(await decoded, route, context, peek);
  }

  async function encodePending<I, R>(
    pending: Promise<R>,
    route: RouteBinding<I, R, Ctx>,
  ): Promise<Response> {
    return route.operation.encodeResult(await pending);
  }

  function directFailure(error: unknown, context?: Ctx): Response | Promise<Response> {
    try {
      if (error instanceof HttpError) return error.toResponse();
      if (options.onUnhandledError && context) return options.onUnhandledError(error, context);
    } catch (conversionError) {
      return Promise.reject(conversionError);
    }
    return Promise.reject(error);
  }

  async function catchDirectError(response: Promise<Response>, context: Ctx): Promise<Response> {
    try {
      return await response;
    } catch (error) {
      return directFailure(error, context);
    }
  }

  const router: ComposableHttpRouter = {
    async handle(request: Request): Promise<Response> {
      return execute(request, matchRequest(request));
    },

    async tryHandle(request: Request): Promise<Response | undefined> {
      const matched = matchRequest(request);
      if (!matched) return undefined;
      return execute(request, matched);
    },
  };
  const originalHandle = router.handle;
  let transportRoutes: readonly HttpTransportRoute[] | undefined;
  const getTransportRoutes =
    !normalizedRoutes || normalizedRoutes.some(({ selection }) => selection !== undefined)
      ? undefined
      : () =>
          (transportRoutes ??= normalizedRoutes.map(({ method, pattern, route }) => ({
            method,
            pattern,
            handle(
              request: Request,
              pathParams: Readonly<Record<string, string>>,
              transport?: HttpRequestTransportInfo,
            ) {
              if (router.handle !== originalHandle) return router.handle(request);
              return execute(request, { route, pathParams }, transport);
            },
            dispatch(request, pathParams, peek, transport) {
              try {
                if (router.handle !== originalHandle) return router.handle(request);
                return executeDirect(request, route, pathParams, peek, transport);
              } catch (error) {
                return Promise.reject(error);
              }
            },
          })));
  transportHandlers.set(router, {
    handle: router.handle,
    getRoutes: getTransportRoutes,
    handleWithTransport(request, transport) {
      return execute(request, matchRequest(request), transport);
    },
  });
  return router;
}
