import type { MatchedRequestContext } from "@typespex/runtime/server";
import { bindRoute, createHttpRouter } from "@typespex/runtime/server";
import { toBunHandler } from "@typespex/shim-bun";
import { PetsOperations } from "../example/generated/pet-store/server-operations.js";
import type { PetStoreServer } from "../example/generated/pet-store/server.js";
import { benchmarkServerPort, createPetFixture } from "./fixture.js";

const pets = createPetFixture();

const implementation: PetStoreServer<MatchedRequestContext> = {
  Pets: {
    list({ limit, offset }) {
      return pets.list(limit, offset);
    },
    create(input) {
      return pets.create(input);
    },
    read({ petId }) {
      return (
        pets.read(petId) ?? {
          code: "NOT_FOUND" as const,
          message: `Pet ${petId} not found`,
        }
      );
    },
    delete({ petId }) {
      if (!pets.read(petId)) {
        return { code: "NOT_FOUND" as const, message: `Pet ${petId} not found` };
      }
      pets.delete(petId);
      return undefined;
    },
    uploadPhoto() {
      throw new Error("The benchmark server does not bind the upload route.");
    },
  },
};

// Bind exactly the same four routes as the comparison servers. The application example's
// auth middleware and upload route are intentionally outside this routing-overhead benchmark.
const router = createHttpRouter([
  bindRoute(PetsOperations.list, implementation.Pets.list),
  bindRoute(PetsOperations.create, implementation.Pets.create),
  bindRoute(PetsOperations.read, implementation.Pets.read),
  bindRoute(PetsOperations.delete, implementation.Pets.delete),
]);

const server = Bun.serve({
  port: benchmarkServerPort(3456),
  ...toBunHandler(router),
});

console.log(`TypeSpex benchmark server running on http://127.0.0.1:${server.port}`);
