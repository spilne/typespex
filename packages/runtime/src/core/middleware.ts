import {
  type BaseRequestContext,
} from "./context.js";

/** Fully assembled request program for one incoming HTTP request. */
export type HttpApp<Ctx extends BaseRequestContext> = (ctx: Ctx) => Promise<Response>;

/** Middleware transforms an `HttpApp` into another `HttpApp`. */
export type Middleware<Ctx extends BaseRequestContext> = (
  app: HttpApp<Ctx>,
) => HttpApp<Ctx>;
