import { Hono } from "hono";

const app = new Hono();
const pets = new Map<string, { id: string; name: string; tag?: string }>();

app.get("/pets", (c) => {
  const all = [...pets.values()];
  const limit = c.req.query("limit") ? parseInt(c.req.query("limit")!, 10) : undefined;
  const offset = c.req.query("offset") ? parseInt(c.req.query("offset")!, 10) : undefined;
  const start = offset ?? 0;
  const end = limit ? start + limit : undefined;
  return c.json(all.slice(start, end));
});

app.post("/pets", async (c) => {
  const body = await c.req.json<{ name: string; tag?: string }>();
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
  port: 3458,
  fetch: (req) => app.fetch(req),
});

console.log(`Hono server running on http://localhost:${server.port}`);
