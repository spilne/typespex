import { Hono } from "hono";
import { benchmarkServerPort, createPetFixture } from "./fixture.js";

const app = new Hono();
const pets = createPetFixture();

app.get("/pets", (context) => {
  const limit = context.req.query("limit")
    ? Number.parseInt(context.req.query("limit")!, 10)
    : undefined;
  const offset = context.req.query("offset")
    ? Number.parseInt(context.req.query("offset")!, 10)
    : undefined;
  return context.json(pets.list(limit, offset));
});

app.post("/pets", async (context) => {
  const input = await context.req.json<{ name: string; tag?: string }>();
  return context.json(pets.create(input));
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
  port: benchmarkServerPort(3458),
  fetch: (request) => app.fetch(request),
});

console.log(`Hono benchmark server running on http://127.0.0.1:${server.port}`);
