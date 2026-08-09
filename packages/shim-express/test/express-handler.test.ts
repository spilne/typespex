import { afterEach, describe, expect, test } from "bun:test";
import { once } from "node:events";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import express, { type Express } from "express";
import {
  Either,
  bindRoute,
  createHttpRouter,
  emptyHints,
  type HttpRouter,
  type ServerOperation,
} from "@typespex/runtime/server";
import { toExpressHandler } from "../src/index.js";

const servers = new Set<Server>();

afterEach(async () => {
  await Promise.all([...servers].map(closeServer));
  servers.clear();
});

interface EchoInput {
  readonly widgetId: string;
  readonly include: string | null;
  readonly requestId: string | null;
  readonly body: { readonly name: string };
}

function createEchoRouter(): HttpRouter {
  const operation: ServerOperation<EchoInput, EchoInput> = {
    endpoint: {
      service: { name: "ExpressApi", hints: emptyHints() },
      namespaces: [],
      operation: {
        name: "echoWidget",
        operationId: "ExpressApi.echoWidget",
        method: "POST",
        path: "/widgets/:widgetId",
        hints: emptyHints(),
      },
    },
    async decodeInput(request, pathParams) {
      const url = new URL(request.url);
      return Either.right({
        widgetId: pathParams.widgetId!,
        include: url.searchParams.get("include"),
        requestId: request.headers.get("x-request-id"),
        body: (await request.json()) as { name: string },
      });
    },
    encodeResult(result) {
      return Response.json(result);
    },
  };

  return createHttpRouter([bindRoute(operation, async (input) => input)]);
}

describe("toExpressHandler", () => {
  test("mounts the router with path, query, header, and JSON body handling", async () => {
    const app = express();
    app.use("/api", toExpressHandler(createEchoRouter()));
    const origin = await listen(app);

    const response = await fetch(`${origin}/api/widgets/w-42?include=details`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-request-id": "req-7",
      },
      body: JSON.stringify({ name: "sample" }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      widgetId: "w-42",
      include: "details",
      requestId: "req-7",
      body: { name: "sample" },
    });
  });

  test("uses the standard adapter 500 response for unhandled failures", async () => {
    const logged: unknown[] = [];
    const router: HttpRouter = {
      async handle() {
        throw new Error("boom");
      },
    };
    const app = express();
    app.use(
      toExpressHandler(router, {
        logger: {
          error(_message, fields) {
            logged.push(fields?.error);
          },
          warn() {},
          info() {},
        },
      }),
    );
    const origin = await listen(app);

    const response = await fetch(`${origin}/failure`);

    expect(response.status).toBe(500);
    expect(await response.text()).toBe("Internal Server Error");
    expect(logged).toHaveLength(1);
    expect(logged[0]).toBeInstanceOf(Error);
  });
});

async function listen(app: Express): Promise<string> {
  const server = app.listen(0, "127.0.0.1");
  servers.add(server);
  await once(server, "listening");
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}
