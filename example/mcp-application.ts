import { definePetAssistantMcpApplication } from "./generated-mcp/pet-assistant/mcp-server.js";

const pets = [
  { id: "poppy", name: "Poppy" },
  { id: "fig", name: "Fig" },
];

export default definePetAssistantMcpApplication({
  kind: "hybrid",
  bridge: {},
  handlers: {
    async getPet({ id }) {
      return (
        pets.find((pet) => pet.id === id) ?? {
          code: "NOT_FOUND" as const,
          message: `Pet ${id} was not found`,
        }
      );
    },

    async listPets() {
      return pets;
    },
  },
});
