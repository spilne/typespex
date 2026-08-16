import { describe, expect, test } from "bun:test";
import type { McpToolContext } from "@typespex/mcp-runtime";
import { executeHttpBridgeTool } from "@typespex/mcp-runtime/http-bridge";
import type { PetStoreServer } from "./generated/pet-store/server.js";
import { createPetStoreServerRouter } from "./generated/pet-store/server-router.js";
import { mcpHttpBridgeOperations } from "./generated-mcp/pet-assistant/mcp-http-client.js";

const context = {
  requestId: "generated-bridge-test",
  signal: new AbortController().signal,
} as McpToolContext;

describe("generated MCP HTTP bridge", () => {
  test("round-trips through an emitter-generated TypeSpex HTTP server", async () => {
    const pets = [{ id: "a/b", name: "Poppy" }];
    const implementation: PetStoreServer = {
      Pets: {
        list: () => pets,
        create: ({ name, tag }) => ({ id: "created", name, tag }),
        read: ({ petId }) =>
          pets.find((pet) => pet.id === petId) ?? {
            code: "NOT_FOUND" as const,
            message: `Pet ${petId} was not found`,
          },
        delete: () => undefined,
        uploadPhoto: () => ({ id: "photo", filename: "photo", size: 0 }),
      },
    };
    const router = createPetStoreServerRouter(implementation);
    let request: Request | undefined;
    const generatedServerFetch = (async (input, init) => {
      request = new Request(input, init);
      return router.handle(request);
    }) as typeof fetch;
    const result = await executeHttpBridgeTool(
      mcpHttpBridgeOperations.getPet,
      { id: "a/b" },
      context,
      { fetch: generatedServerFetch },
    );

    expect(request?.url).toBe("https://pets.example.test/pets/a%2Fb");
    expect(result).toEqual({
      kind: "success",
      status: 200,
      value: { id: "a/b", name: "Poppy" },
    });

    const listed = await executeHttpBridgeTool(mcpHttpBridgeOperations.listPets, {}, context, {
      fetch: generatedServerFetch,
    });
    expect(listed).toEqual({
      kind: "success",
      status: 200,
      value: [{ id: "a/b", name: "Poppy" }],
    });

    const missing = await executeHttpBridgeTool(
      mcpHttpBridgeOperations.getPet,
      { id: "missing" },
      context,
      { fetch: generatedServerFetch },
    );
    expect(missing).toEqual({
      kind: "error",
      status: 404,
      value: { code: "NOT_FOUND", message: "Pet missing was not found" },
    });
  });
});
