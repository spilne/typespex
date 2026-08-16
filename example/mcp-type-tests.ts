import type { PetAssistantMcpHandlers } from "./generated-mcp/pet-assistant/mcp-server.js";

type GetPetInput = Parameters<PetAssistantMcpHandlers["getPet"]>[0];
const validInput: GetPetInput = { id: "pet-1" };
void validInput;

// @ts-expect-error generated handlers reject fields outside the semantic input contract
const invalidInput: GetPetInput = { wire_id: "pet-1" };
void invalidInput;

// @ts-expect-error all generated native handlers are required
const incompleteHandlers: PetAssistantMcpHandlers = {
  getPet: ({ id }) => ({ id, name: id }),
};
void incompleteHandlers;

const invalidResult: PetAssistantMcpHandlers = {
  // @ts-expect-error handler results must match a declared success or error variant
  getPet: () => ({ unexpected: true }),
  listPets: () => [],
};
void invalidResult;
