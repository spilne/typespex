import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod/v4";

const createPetSchema = z.object({
  name: z.string().min(1).max(80).regex(/^[A-Za-z]/, "Must start with a letter."),
  tag: z.string().max(40).optional(),
});

const listQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

const app = new Hono();
const pets = new Map<string, { id: string; name: string; tag?: string }>();

app.get("/pets", zValidator("query", listQuerySchema), (c) => {
  const { limit, offset } = c.req.valid("query");
  const all = [...pets.values()];
  const start = offset ?? 0;
  const end = limit ? start + limit : undefined;
  return c.json(all.slice(start, end));
});

app.post("/pets", zValidator("json", createPetSchema), async (c) => {
  const body = c.req.valid("json");
  const pet = { id: crypto.randomUUID(), ...body };
  pets.set(pet.id, pet);
  return c.json(pet);
});

app.get("/pets/:petId", (c) => {
  const petId = c.req.param("petId");
  const pet = pets.get(petId);
  if (!pet) return c.json({ code: "NOT_FOUND", message: `Pet ${petId} not found` }, 404);
  return c.json(pet);
});

app.delete("/pets/:petId", (c) => {
  const petId = c.req.param("petId");
  const pet = pets.get(petId);
  if (!pet) return c.json({ code: "NOT_FOUND", message: `Pet ${petId} not found` }, 404);
  pets.delete(petId);
  return c.body(null, 204);
});

const server = Bun.serve({
  port: 3459,
  fetch: (req) => app.fetch(req),
});

console.log(`Hono+Zod server running on http://localhost:${server.port}`);
