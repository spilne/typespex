export interface Pet {
  readonly id: string;
  readonly name: string;
  readonly tag?: string;
}

export interface CreatePetInput {
  readonly name: string;
  readonly tag?: string;
}

export const CREATE_PET_INPUT: CreatePetInput = Object.freeze({ name: "Bench", tag: "test" });
export const CREATED_PET: Pet = Object.freeze({ id: "created-pet", ...CREATE_PET_INPUT });
export const INITIAL_PETS: readonly Pet[] = Object.freeze(
  Array.from({ length: 20 }, (_, index) =>
    Object.freeze({ id: `pet-${index}`, name: `Pet${index}`, tag: `tag${index % 5}` }),
  ),
);

export interface PetFixture {
  list(limit?: number, offset?: number): Pet[];
  create(input: CreatePetInput): Pet;
  read(petId: string): Pet | undefined;
  delete(petId: string): boolean;
}

/**
 * Creates the identical, bounded business-logic fixture used by every HTTP server.
 * POST intentionally does not mutate the collection, so a load test cannot become a
 * benchmark of Map growth, UUID generation, or an ever-expanding heap.
 */
export function createPetFixture(): PetFixture {
  const pets = new Map(INITIAL_PETS.map((pet) => [pet.id, pet]));
  return {
    list(limit, offset) {
      const all = [...pets.values()];
      const start = offset ?? 0;
      const end = limit === undefined ? undefined : start + limit;
      return all.slice(start, end);
    },
    create(input) {
      return {
        id: CREATED_PET.id,
        name: input.name,
        ...(input.tag === undefined ? {} : { tag: input.tag }),
      };
    },
    read(petId) {
      return pets.get(petId);
    },
    delete(petId) {
      return pets.delete(petId);
    },
  };
}

export function benchmarkServerPort(fallback: number): number {
  const raw = Bun.env.TYPESPEX_BENCH_PORT;
  if (raw === undefined) return fallback;
  const port = Number(raw);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error("TYPESPEX_BENCH_PORT must be an integer between 1 and 65535.");
  }
  return port;
}
