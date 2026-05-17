import { describe, expect, test } from "bun:test";
import { Either } from "@typespex/runtime/server";
import type { PetStoreServer } from "./generated/pet-store/server.js";
import type { Pet } from "./generated/pet-store/models.js";
import { createPetStoreServerRouter } from "./generated/pet-store/server-router.js";

// ---------------------------------------------------------------------------
// In-memory store + handler implementation
// ---------------------------------------------------------------------------

function createTestServer() {
  const store = new Map<string, Pet>();

  const impl: PetStoreServer = {
    Pets: {
      list: async ({ limit, offset }) => {
        const all = [...store.values()];
        const start = offset ?? 0;
        const end = limit ? start + limit : undefined;
        return Either.right(all.slice(start, end));
      },

      create: async (input) => {
        if (store.has(input.name)) {
          return Either.left({ code: "CONFLICT" as const, message: `${input.name} exists` });
        }
        const item: Pet = { id: crypto.randomUUID(), name: input.name, tag: input.tag };
        store.set(item.name, item);
        return Either.right(item);
      },

      read: async ({ petId }) => {
        const item = [...store.values()].find((i) => i.id === petId);
        if (!item) return Either.left({ code: "NOT_FOUND" as const, message: "not found" });
        return Either.right(item);
      },

      delete: async ({ petId }, ctx) => {
        const authScope = ctx.match?.endpoint.operation.hints.get(
          (await import("./generated/pet-store/server-hints.js")).authHint,
        );
        if (authScope === "admin") {
          const isAdmin = ctx.request.headers.get("x-role") === "admin";
          if (!isAdmin) {
            return Either.left({ code: "FORBIDDEN" as const, message: "admin only" });
          }
        }

        const item = [...store.values()].find((i) => i.id === petId);
        if (!item) return Either.left({ code: "NOT_FOUND" as const, message: "not found" });
        store.delete(item.name);
        return Either.right(undefined);
      },
    },
  };

  const router = createPetStoreServerRouter(impl);
  return { router, store };
}

function req(method: string, path: string, body?: unknown, headers?: Record<string, string>): Request {
  const init: RequestInit = { method, headers: { ...headers } };
  if (body !== undefined) {
    (init.headers as Record<string, string>)["content-type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  return new Request(`http://localhost${path}`, init);
}

async function createItem(router: { handle(r: Request): Promise<Response> }, name: string, tag?: string): Promise<Pet> {
  const res = await router.handle(req("POST", "/pets", { name, tag }));
  return res.json();
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("e2e: full request pipeline", () => {
  // -------------------------------------------------------------------
  // GET /pets — list with optional query params
  // -------------------------------------------------------------------

  describe("GET /pets", () => {
    test("returns empty list initially", async () => {
      const { router } = createTestServer();
      const res = await router.handle(req("GET", "/pets"));

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual([]);
    });

    test("returns items with limit and offset", async () => {
      const { router } = createTestServer();
      await createItem(router, "Alpha");
      await createItem(router, "Bravo");
      await createItem(router, "Charlie");

      const all = await (await router.handle(req("GET", "/pets"))).json();
      expect(all.length).toBe(3);

      const limited = await (await router.handle(req("GET", "/pets?limit=2"))).json();
      expect(limited.length).toBe(2);
      expect(limited[0].name).toBe("Alpha");
      expect(limited[1].name).toBe("Bravo");

      const paged = await (await router.handle(req("GET", "/pets?limit=2&offset=1"))).json();
      expect(paged.length).toBe(2);
      expect(paged[0].name).toBe("Bravo");
      expect(paged[1].name).toBe("Charlie");
    });

    test("succeeds when optional params are absent", async () => {
      const { router } = createTestServer();
      const res = await router.handle(req("GET", "/pets"));

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual([]);
    });

    test("rejects limit below minValue", async () => {
      const { router } = createTestServer();
      const res = await router.handle(req("GET", "/pets?limit=0"));

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toBe("Invalid request");
      expect(body.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ path: expect.stringContaining("limit") }),
        ]),
      );
    });

    test("rejects limit above maxValue", async () => {
      const { router } = createTestServer();
      const res = await router.handle(req("GET", "/pets?limit=101"));

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ path: expect.stringContaining("limit") }),
        ]),
      );
    });

    test("rejects non-numeric limit", async () => {
      const { router } = createTestServer();
      const res = await router.handle(req("GET", "/pets?limit=abc"));

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            path: expect.stringContaining("limit"),
            message: expect.stringContaining("number"),
          }),
        ]),
      );
    });
  });

  // -------------------------------------------------------------------
  // POST /pets — create with body validation
  // -------------------------------------------------------------------

  describe("POST /pets", () => {
    test("creates item with valid body", async () => {
      const { router } = createTestServer();
      const res = await router.handle(req("POST", "/pets", { name: "Fido", tag: "dog" }));

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toEqual({
        id: expect.any(String),
        name: "Fido",
        tag: "dog",
      });
    });

    test("accepts body without optional tag", async () => {
      const { router } = createTestServer();
      const res = await router.handle(req("POST", "/pets", { name: "Solo" }));

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.name).toBe("Solo");
      expect(body.tag).toBeUndefined();
    });

    test("rejects empty name (minLength)", async () => {
      const { router } = createTestServer();
      const res = await router.handle(req("POST", "/pets", { name: "" }));

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            path: expect.stringContaining("name"),
            message: expect.stringContaining("1"),
          }),
        ]),
      );
    });

    test("rejects name starting with number (pattern)", async () => {
      const { router } = createTestServer();
      const res = await router.handle(req("POST", "/pets", { name: "123bad" }));

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            path: expect.stringContaining("name"),
            message: expect.stringContaining("letter"),
          }),
        ]),
      );
    });

    test("rejects name exceeding maxLength", async () => {
      const { router } = createTestServer();
      const res = await router.handle(req("POST", "/pets", { name: "A".repeat(81) }));

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ path: expect.stringContaining("name") }),
        ]),
      );
    });

    test("rejects tag exceeding maxLength", async () => {
      const { router } = createTestServer();
      const res = await router.handle(req("POST", "/pets", { name: "Valid", tag: "x".repeat(41) }));

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ path: expect.stringContaining("tag") }),
        ]),
      );
    });

    test("rejects missing name field", async () => {
      const { router } = createTestServer();
      const res = await router.handle(req("POST", "/pets", { tag: "orphan" }));

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ path: expect.stringContaining("name") }),
        ]),
      );
    });

    test("rejects malformed JSON body", async () => {
      const { router } = createTestServer();
      const res = await router.handle(
        new Request("http://localhost/pets", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "not json{",
        }),
      );

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ message: expect.stringContaining("JSON") }),
        ]),
      );
    });

    test("accumulates multiple validation errors", async () => {
      const { router } = createTestServer();
      const res = await router.handle(req("POST", "/pets", { name: "", tag: "x".repeat(41) }));

      expect(res.status).toBe(400);
      const body = await res.json();
      const paths = body.issues.map((i: any) => i.path);
      expect(paths).toEqual(
        expect.arrayContaining([
          expect.stringContaining("name"),
          expect.stringContaining("tag"),
        ]),
      );
    });

    test("returns 409 ConflictError on duplicate name", async () => {
      const { router } = createTestServer();
      await createItem(router, "Duplicate");
      const res = await router.handle(req("POST", "/pets", { name: "Duplicate" }));

      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({
        code: "CONFLICT",
        message: "Duplicate exists",
      });
    });
  });

  // -------------------------------------------------------------------
  // GET /pets/:petId — read with path param
  // -------------------------------------------------------------------

  describe("GET /pets/:petId", () => {
    test("returns item by id", async () => {
      const { router } = createTestServer();
      const created = await createItem(router, "Rex", "shepherd");
      const res = await router.handle(req("GET", `/pets/${created.id}`));

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        id: created.id,
        name: "Rex",
        tag: "shepherd",
      });
    });

    test("returns 404 for unknown id", async () => {
      const { router } = createTestServer();
      const res = await router.handle(req("GET", "/pets/nonexistent"));

      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({
        code: "NOT_FOUND",
        message: "not found",
      });
    });

    test("rejects whitespace-only petId (minLength validation)", async () => {
      const { router } = createTestServer();
      const res = await router.handle(req("GET", "/pets/%20"));

      // Whitespace-only petId should fail minLength or route miss
      expect([400, 404]).toContain(res.status);
      if (res.status === 400) {
        const body = await res.json();
        expect(body.issues).toBeDefined();
      }
    });

    test("decodes URL-encoded path params", async () => {
      const { router } = createTestServer();
      const created = await createItem(router, "Spot");
      const encodedId = encodeURIComponent(created.id);
      const res = await router.handle(req("GET", `/pets/${encodedId}`));

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        id: created.id,
        name: "Spot",
      });
    });
  });

  // -------------------------------------------------------------------
  // DELETE /pets/:petId — void response + discriminated errors
  // -------------------------------------------------------------------

  describe("DELETE /pets/:petId", () => {
    test("returns 204 with empty body on successful delete", async () => {
      const { router } = createTestServer();
      const created = await createItem(router, "Temp");
      const res = await router.handle(
        req("DELETE", `/pets/${created.id}`, undefined, { "x-role": "admin" }),
      );

      expect(res.status).toBe(204);
      expect(await res.text()).toBe("");
    });

    test("returns 404 NotFoundError for unknown id", async () => {
      const { router } = createTestServer();
      const res = await router.handle(
        req("DELETE", "/pets/unknown", undefined, { "x-role": "admin" }),
      );

      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({
        code: "NOT_FOUND",
        message: "not found",
      });
    });

    test("returns 403 ForbiddenError when not admin (discriminated error)", async () => {
      const { router } = createTestServer();
      const created = await createItem(router, "Protected");
      const res = await router.handle(req("DELETE", `/pets/${created.id}`));

      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({
        code: "FORBIDDEN",
        message: "admin only",
      });
    });

    test("item is removed from store after delete", async () => {
      const { router } = createTestServer();
      const created = await createItem(router, "Bye");
      await router.handle(req("DELETE", `/pets/${created.id}`, undefined, { "x-role": "admin" }));

      const res = await router.handle(req("GET", `/pets/${created.id}`));
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({
        code: "NOT_FOUND",
        message: "not found",
      });
    });
  });

  // -------------------------------------------------------------------
  // Routing edge cases
  // -------------------------------------------------------------------

  describe("routing", () => {
    test("returns 404 JSON for unknown path", async () => {
      const { router } = createTestServer();
      const res = await router.handle(req("GET", "/unknown"));

      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: "Not Found" });
    });

    test("returns 404 for wrong method on existing path", async () => {
      const { router } = createTestServer();
      const res = await router.handle(req("PUT", "/pets"));

      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: "Not Found" });
    });

    test("returns 404 for extra path segments", async () => {
      const { router } = createTestServer();
      const res = await router.handle(req("GET", "/pets/abc/extra/segments"));

      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: "Not Found" });
    });
  });

  // -------------------------------------------------------------------
  // Metadata / hints
  // -------------------------------------------------------------------

  describe("operation metadata", () => {
    test("auth hint is accessible and enforced by handler", async () => {
      const { router } = createTestServer();
      const created = await createItem(router, "Guarded");

      // No x-role header → handler reads auth hint → returns 403
      const forbidden = await router.handle(req("DELETE", `/pets/${created.id}`));
      expect(forbidden.status).toBe(403);
      expect(await forbidden.json()).toEqual({
        code: "FORBIDDEN",
        message: "admin only",
      });

      // With x-role: admin → succeeds
      const ok = await router.handle(
        req("DELETE", `/pets/${created.id}`, undefined, { "x-role": "admin" }),
      );
      expect(ok.status).toBe(204);
    });
  });
});
