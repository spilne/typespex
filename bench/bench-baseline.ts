// Bare Bun server — equivalent routes, no framework overhead
const pets = new Map<string, { id: string; name: string; tag?: string }>();

const server = Bun.serve({
  port: 3457,
  async fetch(req) {
    const url = new URL(req.url);
    const method = req.method;
    const path = url.pathname;

    // GET /pets
    if (method === "GET" && path === "/pets") {
      const all = [...pets.values()];
      const limit = url.searchParams.has("limit")
        ? parseInt(url.searchParams.get("limit")!, 10)
        : undefined;
      const offset = url.searchParams.has("offset")
        ? parseInt(url.searchParams.get("offset")!, 10)
        : undefined;
      const start = offset ?? 0;
      const end = limit ? start + limit : undefined;
      return Response.json(all.slice(start, end));
    }

    // POST /pets
    if (method === "POST" && path === "/pets") {
      const body = (await req.json()) as { name: string; tag?: string };
      const pet = { id: crypto.randomUUID(), ...body };
      pets.set(pet.id, pet);
      return Response.json(pet);
    }

    // GET /pets/:petId
    if (method === "GET" && path.startsWith("/pets/") && path.split("/").length === 3) {
      const petId = decodeURIComponent(path.split("/")[2]);
      const pet = pets.get(petId);
      if (!pet)
        return Response.json(
          { code: "NOT_FOUND", message: `Pet ${petId} not found` },
          { status: 404 },
        );
      return Response.json(pet);
    }

    // DELETE /pets/:petId
    if (method === "DELETE" && path.startsWith("/pets/") && path.split("/").length === 3) {
      const petId = decodeURIComponent(path.split("/")[2]);
      const pet = pets.get(petId);
      if (!pet)
        return Response.json(
          { code: "NOT_FOUND", message: `Pet ${petId} not found` },
          { status: 404 },
        );
      pets.delete(petId);
      return new Response(null, { status: 204 });
    }

    return Response.json({ error: "Not Found" }, { status: 404 });
  },
});

console.log(`Baseline server running on http://localhost:${server.port}`);
