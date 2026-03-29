import { Either, type MatchedRequestContext } from "@typespex/runtime/server";
import { toBunHandler } from "@typespex/shim-bun";
import type { PetStoreServer } from "./generated/server.js";
import { createPetStoreServerRouter } from "./generated/server-router.js";

// In-memory pet store
const pets = new Map<string, { id: string; name: string; tag?: string }>();

// Pure business logic handlers — zero HTTP awareness
const serverImpl: PetStoreServer<MatchedRequestContext> = {
  Pets: {
    async list({ limit, offset }, ctx) {
      console.log(`[${ctx.match.endpoint.operation.operationId}] limit=${limit} offset=${offset}`);
      const all = [...pets.values()];
      const start = offset ?? 0;
      const end = limit ? start + limit : undefined;
      return Either.right(all.slice(start, end));
    },

    async create(input, ctx) {
      console.log(`[${ctx.match.endpoint.operation.operationId}] creating pet: ${input.name}`);
      const pet = { id: crypto.randomUUID(), ...input };
      pets.set(pet.id, pet);
      return Either.right(pet);
    },

    async read({ petId }, ctx) {
      console.log(`[${ctx.match.endpoint.operation.operationId}] reading pet: ${petId}`);
      const pet = pets.get(petId);
      if (!pet) {
        return Either.left({
          code: "NOT_FOUND" as const,
          message: `Pet ${petId} not found`,
        });
      }
      return Either.right(pet);
    },

    async delete({ petId }, ctx) {
      console.log(`[${ctx.match.endpoint.operation.operationId}] deleting pet: ${petId}`);
      const pet = pets.get(petId);
      if (!pet) {
        return Either.left({
          code: "NOT_FOUND" as const,
          message: `Pet ${petId} not found`,
        });
      }
      pets.delete(petId);
      return Either.right(undefined);
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
