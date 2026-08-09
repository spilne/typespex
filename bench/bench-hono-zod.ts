import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { z } from "zod/v4";
import { benchmarkServerPort, createPetFixture } from "./fixture.js";

const createPetSchema = z.object({
  name: z
    .string()
    .min(1)
    .max(80)
    .regex(/^[A-Za-z]/, "Must start with a letter."),
  tag: z.string().max(40).optional(),
});

const listQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

const app = new Hono();
const pets = createPetFixture();

app.get("/pets", zValidator("query", listQuerySchema), (context) => {
  const { limit, offset } = context.req.valid("query");
  return context.json(pets.list(limit, offset));
});

app.post("/pets", zValidator("json", createPetSchema), (context) => {
  return context.json(pets.create(context.req.valid("json")));
});

app.get("/pets/:petId", (context) => {
  const petId = context.req.param("petId");
  const pet = pets.read(petId);
  if (!pet) return context.json({ code: "NOT_FOUND", message: `Pet ${petId} not found` }, 404);
  return context.json(pet);
});

app.delete("/pets/:petId", (context) => {
  const petId = context.req.param("petId");
  const pet = pets.read(petId);
  if (!pet) return context.json({ code: "NOT_FOUND", message: `Pet ${petId} not found` }, 404);
  pets.delete(petId);
  return context.body(null, 204);
});

const server = Bun.serve({
  port: benchmarkServerPort(3459),
  fetch: (request) => app.fetch(request),
});

console.log(`Hono+Zod benchmark server running on http://127.0.0.1:${server.port}`);
