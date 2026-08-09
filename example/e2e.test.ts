import { describe, expect, test } from "bun:test";
import { bearerAuthMiddleware } from "./auth.js";
import type { PetStoreServer } from "./generated/pet-store/server.js";
import type { Pet, UploadResult } from "./generated/pet-store/models.js";
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
        return all.slice(start, end);
      },

      create: async (input) => {
        if (store.has(input.name)) {
          return { code: "CONFLICT" as const, message: `${input.name} exists` };
        }
        const item: Pet = { id: crypto.randomUUID(), name: input.name, tag: input.tag };
        store.set(item.name, item);
        return item;
      },

      read: async ({ petId }) => {
        const item = [...store.values()].find((i) => i.id === petId);
        if (!item) return { code: "NOT_FOUND" as const, message: "not found" };
        return item;
      },

      delete: async ({ petId }) => {
        const item = [...store.values()].find((i) => i.id === petId);
        if (!item) return { code: "NOT_FOUND" as const, message: "not found" };
        store.delete(item.name);
        return undefined;
      },

      uploadPhoto: async ({ petId, caption, photo }) => {
        const item = [...store.values()].find((i) => i.id === petId);
        if (!item) return { code: "NOT_FOUND" as const, message: "not found" };
        return {
          id: crypto.randomUUID(),
          filename: photo.name,
          size: photo.size,
        };
      },
    },
  };

  const router = createPetStoreServerRouter(impl, {
    middleware: [bearerAuthMiddleware],
  });
  return { router, store };
}

function req(
  method: string,
  path: string,
  body?: unknown,
  headers?: Record<string, string>,
): Request {
  const init: RequestInit = { method, headers: { ...headers } };
  if (body !== undefined) {
    (init.headers as Record<string, string>)["content-type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  return new Request(`http://localhost${path}`, init);
}

async function createItem(
  router: { handle(r: Request): Promise<Response> },
  name: string,
  tag?: string,
): Promise<Pet> {
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
        expect.arrayContaining([expect.objectContaining({ path: expect.stringContaining("tag") })]),
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
        expect.arrayContaining([expect.stringContaining("name"), expect.stringContaining("tag")]),
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
        req("DELETE", `/pets/${created.id}`, undefined, {
          authorization: "Bearer example-token",
        }),
      );

      expect(res.status).toBe(204);
      expect(await res.text()).toBe("");
    });

    test("returns 404 NotFoundError for unknown id", async () => {
      const { router } = createTestServer();
      const res = await router.handle(
        req("DELETE", "/pets/unknown", undefined, {
          authorization: "Bearer example-token",
        }),
      );

      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({
        code: "NOT_FOUND",
        message: "not found",
      });
    });

    test("returns 401 UnauthorizedError without a bearer credential", async () => {
      const { router } = createTestServer();
      const created = await createItem(router, "Protected");
      const res = await router.handle(req("DELETE", `/pets/${created.id}`));

      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({
        code: "UNAUTHORIZED",
        message: "A bearer token is required.",
      });
    });

    test("item is removed from store after delete", async () => {
      const { router } = createTestServer();
      const created = await createItem(router, "Bye");
      await router.handle(
        req("DELETE", `/pets/${created.id}`, undefined, {
          authorization: "Bearer example-token",
        }),
      );

      const res = await router.handle(req("GET", `/pets/${created.id}`));
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({
        code: "NOT_FOUND",
        message: "not found",
      });
    });
  });

  // -------------------------------------------------------------------
  // POST /pets/:petId/photo — multipart file upload
  // -------------------------------------------------------------------

  describe("POST /pets/:petId/photo", () => {
    test("uploads a file with caption", async () => {
      const { router } = createTestServer();
      const pet = await createItem(router, "Photogenic");

      const formData = new FormData();
      formData.append("caption", "A nice photo");
      formData.append("photo", new File(["image-data"], "photo.jpg", { type: "image/jpeg" }));

      const res = await router.handle(
        new Request(`http://localhost/pets/${pet.id}/photo`, {
          method: "POST",
          body: formData,
        }),
      );

      expect(res.status).toBe(200);
      const body: UploadResult = await res.json();
      expect(body.id).toBeDefined();
      expect(body.filename).toBe("photo.jpg");
      expect(body.size).toBe(10); // "image-data".length
    });

    test("uploads without optional caption", async () => {
      const { router } = createTestServer();
      const pet = await createItem(router, "NoCap");

      const formData = new FormData();
      formData.append("photo", new File(["data"], "img.png", { type: "image/png" }));

      const res = await router.handle(
        new Request(`http://localhost/pets/${pet.id}/photo`, {
          method: "POST",
          body: formData,
        }),
      );

      expect(res.status).toBe(200);
      const body: UploadResult = await res.json();
      expect(body.filename).toBe("img.png");
    });

    test("returns 404 for unknown pet", async () => {
      const { router } = createTestServer();

      const formData = new FormData();
      formData.append("photo", new File(["data"], "x.jpg", { type: "image/jpeg" }));

      const res = await router.handle(
        new Request("http://localhost/pets/nonexistent/photo", {
          method: "POST",
          body: formData,
        }),
      );

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
    test("standard auth hint is enforced by middleware", async () => {
      const { router } = createTestServer();
      const created = await createItem(router, "Guarded");

      // No Authorization header → middleware reads the resolved auth hint.
      const unauthorized = await router.handle(req("DELETE", `/pets/${created.id}`));
      expect(unauthorized.status).toBe(401);
      expect(await unauthorized.json()).toEqual({
        code: "UNAUTHORIZED",
        message: "A bearer token is required.",
      });

      // A bearer credential satisfies this application's example policy.
      const ok = await router.handle(
        req("DELETE", `/pets/${created.id}`, undefined, {
          authorization: "Bearer example-token",
        }),
      );
      expect(ok.status).toBe(204);
    });
  });
});
