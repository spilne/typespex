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
        // Check auth hint
        const authScope = ctx.match?.endpoint.operation.hints.get(
          (await import("./generated/pet-store/server-hints.js")).authHint,
        );
        if (authScope === "admin") {
          // Simulate forbidden for non-admin
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

      // Seed 3 items
      await router.handle(req("POST", "/pets", { name: "Alpha" }));
      await router.handle(req("POST", "/pets", { name: "Bravo" }));
      await router.handle(req("POST", "/pets", { name: "Charlie" }));

      const all = await router.handle(req("GET", "/pets"));
      expect((await all.json()).length).toBe(3);

      const limited = await router.handle(req("GET", "/pets?limit=2"));
      expect((await limited.json()).length).toBe(2);

      const offset = await router.handle(req("GET", "/pets?limit=2&offset=1"));
      const items = await offset.json();
      expect(items.length).toBe(2);
      expect(items[0].name).toBe("Bravo");
    });

    test("succeeds when optional params are absent", async () => {
      const { router } = createTestServer();
      const res = await router.handle(req("GET", "/pets"));

      expect(res.status).toBe(200);
    });

    test("rejects limit below minValue", async () => {
      const { router } = createTestServer();
      const res = await router.handle(req("GET", "/pets?limit=0"));

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.issues).toBeDefined();
      expect(body.issues.some((i: any) => i.path.includes("limit"))).toBe(true);
    });

    test("rejects limit above maxValue", async () => {
      const { router } = createTestServer();
      const res = await router.handle(req("GET", "/pets?limit=101"));

      expect(res.status).toBe(400);
    });

    test("rejects non-numeric limit", async () => {
      const { router } = createTestServer();
      const res = await router.handle(req("GET", "/pets?limit=abc"));

      expect(res.status).toBe(400);
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
      expect(body.id).toBeDefined();
      expect(body.name).toBe("Fido");
      expect(body.tag).toBe("dog");
    });

    test("accepts body without optional tag", async () => {
      const { router } = createTestServer();
      const res = await router.handle(req("POST", "/pets", { name: "Solo" }));

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.name).toBe("Solo");
    });

    test("rejects empty name (minLength)", async () => {
      const { router } = createTestServer();
      const res = await router.handle(req("POST", "/pets", { name: "" }));

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.issues.some((i: any) => i.path.includes("name"))).toBe(true);
    });

    test("rejects name starting with number (pattern)", async () => {
      const { router } = createTestServer();
      const res = await router.handle(req("POST", "/pets", { name: "123bad" }));

      expect(res.status).toBe(400);
    });

    test("rejects name exceeding maxLength", async () => {
      const { router } = createTestServer();
      const res = await router.handle(req("POST", "/pets", { name: "A".repeat(81) }));

      expect(res.status).toBe(400);
    });

    test("rejects tag exceeding maxLength", async () => {
      const { router } = createTestServer();
      const res = await router.handle(req("POST", "/pets", { name: "Valid", tag: "x".repeat(41) }));

      expect(res.status).toBe(400);
    });

    test("rejects missing name field", async () => {
      const { router } = createTestServer();
      const res = await router.handle(req("POST", "/pets", { tag: "orphan" }));

      expect(res.status).toBe(400);
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
    });

    test("accumulates multiple validation errors", async () => {
      const { router } = createTestServer();
      const res = await router.handle(req("POST", "/pets", { name: "", tag: "x".repeat(41) }));

      expect(res.status).toBe(400);
      const body = await res.json();
      // At least 2 errors: name minLength + tag maxLength
      expect(body.issues.length).toBeGreaterThanOrEqual(2);
    });

    test("returns 409 ConflictError on duplicate name", async () => {
      const { router } = createTestServer();
      await router.handle(req("POST", "/pets", { name: "Duplicate" }));
      const res = await router.handle(req("POST", "/pets", { name: "Duplicate" }));

      expect(res.status).toBe(409);
      const body = await res.json();
      expect(body.code).toBe("CONFLICT");
    });
  });

  // -------------------------------------------------------------------
  // GET /pets/:petId — read with path param
  // -------------------------------------------------------------------

  describe("GET /pets/:petId", () => {
    test("returns item by id", async () => {
      const { router } = createTestServer();
      const created = await (await router.handle(req("POST", "/pets", { name: "Rex" }))).json();
      const res = await router.handle(req("GET", `/pets/${created.id}`));

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual(created);
    });

    test("returns 404 for unknown id", async () => {
      const { router } = createTestServer();
      const res = await router.handle(req("GET", "/pets/nonexistent"));

      expect(res.status).toBe(404);
      const body = await res.json();
      expect(body.code).toBe("NOT_FOUND");
      expect(body.message).toBeDefined();
    });

    test("rejects empty petId (minLength validation)", async () => {
      const { router } = createTestServer();
      // Path param can't really be empty in URL, but /pets/ with trailing slash
      // routes differently — this tests the validation path
      const res = await router.handle(req("GET", "/pets/%20"));

      // Whitespace petId should fail minLength or not match the route
      expect([400, 404]).toContain(res.status);
    });

    test("decodes URL-encoded path params", async () => {
      const { router } = createTestServer();
      // Create an item, then read it using a URL-encoded id
      const created = await (await router.handle(req("POST", "/pets", { name: "Spot" }))).json();
      const encodedId = encodeURIComponent(created.id);
      const res = await router.handle(req("GET", `/pets/${encodedId}`));

      expect(res.status).toBe(200);
      expect((await res.json()).id).toBe(created.id);
    });
  });

  // -------------------------------------------------------------------
  // DELETE /pets/:petId — void response + discriminated errors
  // -------------------------------------------------------------------

  describe("DELETE /pets/:petId", () => {
    test("returns 204 on successful delete", async () => {
      const { router } = createTestServer();
      const created = await (await router.handle(req("POST", "/pets", { name: "Temp" }))).json();
      const res = await router.handle(
        req("DELETE", `/pets/${created.id}`, undefined, { "x-role": "admin" }),
      );

      expect(res.status).toBe(204);
      const body = await res.text();
      expect(body).toBe("");
    });

    test("returns 404 for unknown id", async () => {
      const { router } = createTestServer();
      const res = await router.handle(
        req("DELETE", "/pets/unknown", undefined, { "x-role": "admin" }),
      );

      expect(res.status).toBe(404);
      const body = await res.json();
      expect(body.code).toBe("NOT_FOUND");
    });

    test("returns 403 when not admin (discriminated error)", async () => {
      const { router } = createTestServer();
      const created = await (await router.handle(req("POST", "/pets", { name: "Protected" }))).json();
      const res = await router.handle(req("DELETE", `/pets/${created.id}`));

      expect(res.status).toBe(403);
      const body = await res.json();
      expect(body.code).toBe("FORBIDDEN");
    });

    test("item is actually deleted", async () => {
      const { router } = createTestServer();
      const created = await (await router.handle(req("POST", "/pets", { name: "Bye" }))).json();
      await router.handle(req("DELETE", `/pets/${created.id}`, undefined, { "x-role": "admin" }));

      const res = await router.handle(req("GET", `/pets/${created.id}`));
      expect(res.status).toBe(404);
    });
  });

  // -------------------------------------------------------------------
  // Routing edge cases
  // -------------------------------------------------------------------

  describe("routing", () => {
    test("returns 404 for unknown path", async () => {
      const { router } = createTestServer();
      const res = await router.handle(req("GET", "/unknown"));

      expect(res.status).toBe(404);
    });

    test("returns 404 for wrong method", async () => {
      const { router } = createTestServer();
      const res = await router.handle(req("PUT", "/pets"));

      expect(res.status).toBe(404);
    });

    test("returns 404 for nested unknown path", async () => {
      const { router } = createTestServer();
      const res = await router.handle(req("GET", "/pets/abc/extra/segments"));

      expect(res.status).toBe(404);
    });
  });

  // -------------------------------------------------------------------
  // Metadata / hints
  // -------------------------------------------------------------------

  describe("operation metadata", () => {
    test("auth hint is accessible on delete operation", async () => {
      // The delete handler reads the auth hint and enforces it.
      // A successful 403 response proves the hint was readable.
      const { router } = createTestServer();
      const created = await (await router.handle(req("POST", "/pets", { name: "Guarded" }))).json();
      const res = await router.handle(req("DELETE", `/pets/${created.id}`));

      expect(res.status).toBe(403);
    });
  });
});
