import type { MatchedRequestContext } from "@typespex/runtime/server";
import { toBunHandler } from "@typespex/shim-bun";
import type { PetStoreServer } from "./generated/pet-store/server.js";
import { createPetStoreServerRouter } from "./generated/pet-store/server-router.js";

// In-memory pet store
const pets = new Map<string, { id: string; name: string; tag?: string }>();
const logRequests = Bun.env.TYPESPEX_BENCHMARK !== "1";

// Pure business logic handlers — zero HTTP awareness
const serverImpl: PetStoreServer<MatchedRequestContext> = {
  Pets: {
    async list({ limit, offset }, ctx) {
      if (logRequests) {
        console.log(
          `[${ctx.match.endpoint.operation.operationId}] limit=${limit} offset=${offset}`,
        );
      }
      const all = [...pets.values()];
      const start = offset ?? 0;
      const end = limit ? start + limit : undefined;
      return all.slice(start, end);
    },

    async create(input, ctx) {
      if (logRequests) {
        console.log(`[${ctx.match.endpoint.operation.operationId}] creating pet: ${input.name}`);
      }
      const pet = { id: crypto.randomUUID(), ...input };
      pets.set(pet.id, pet);
      return pet;
    },

    async read({ petId }, ctx) {
      if (logRequests) {
        console.log(`[${ctx.match.endpoint.operation.operationId}] reading pet: ${petId}`);
      }
      const pet = pets.get(petId);
      if (!pet) {
        return {
          code: "NOT_FOUND" as const,
          message: `Pet ${petId} not found`,
        };
      }
      return pet;
    },

    async delete({ petId }, ctx) {
      if (logRequests) {
        console.log(`[${ctx.match.endpoint.operation.operationId}] deleting pet: ${petId}`);
      }
      const pet = pets.get(petId);
      if (!pet) {
        return {
          code: "NOT_FOUND" as const,
          message: `Pet ${petId} not found`,
        };
      }
      pets.delete(petId);
      return undefined;
    },

    async uploadPhoto({ petId, caption, photo }) {
      const pet = pets.get(petId);
      if (!pet) return { code: "NOT_FOUND" as const, message: "not found" };
      return {
        id: crypto.randomUUID(),
        filename: photo.name,
        size: photo.size,
      };
    },
  },
};

const router = createPetStoreServerRouter(serverImpl);
const handler = toBunHandler(router);

const server = Bun.serve({
  port: 3456,
  ...handler,
});

console.log(`PetStore server running on http://localhost:${server.port}`);
