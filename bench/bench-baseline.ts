import { benchmarkServerPort, createPetFixture } from "./fixture.js";

// Bare Bun server — the same four routes and fixture, without framework overhead.
const pets = createPetFixture();

const server = Bun.serve({
  port: benchmarkServerPort(3457),
  async fetch(request) {
    const url = new URL(request.url);
    const { pathname } = url;

    if (request.method === "GET" && pathname === "/pets") {
      const limit = url.searchParams.has("limit")
        ? Number.parseInt(url.searchParams.get("limit")!, 10)
        : undefined;
      const offset = url.searchParams.has("offset")
        ? Number.parseInt(url.searchParams.get("offset")!, 10)
        : undefined;
      return Response.json(pets.list(limit, offset));
    }

    if (request.method === "POST" && pathname === "/pets") {
      const input = (await request.json()) as { name: string; tag?: string };
      return Response.json(pets.create(input));
    }

    if (
      (request.method === "GET" || request.method === "DELETE") &&
      pathname.startsWith("/pets/") &&
      pathname.split("/").length === 3
    ) {
      const petId = decodeURIComponent(pathname.split("/")[2]!);
      const pet = pets.read(petId);
      if (!pet) {
        return Response.json(
          { code: "NOT_FOUND", message: `Pet ${petId} not found` },
          { status: 404 },
        );
      }
      if (request.method === "GET") return Response.json(pet);
      if (request.method === "DELETE") {
        pets.delete(petId);
        return new Response(null, { status: 204 });
      }
    }

    return Response.json({ error: "Not Found" }, { status: 404 });
  },
});

console.log(`Bare Bun benchmark server running on http://127.0.0.1:${server.port}`);
