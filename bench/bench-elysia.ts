import { Elysia, t } from "elysia";
import { benchmarkServerPort, createPetFixture } from "./fixture.js";

const pets = createPetFixture();
const app = new Elysia()
  .get("/pets", ({ query }) => pets.list(query.limit, query.offset), {
    query: t.Object({
      limit: t.Optional(t.Integer({ minimum: 1, maximum: 100 })),
      offset: t.Optional(t.Integer({ minimum: 0 })),
    }),
  })
  .post("/pets", ({ body }) => pets.create(body), {
    body: t.Object({
      name: t.String({ minLength: 1, maxLength: 80, pattern: "^[A-Za-z]" }),
      tag: t.Optional(t.String({ maxLength: 40 })),
    }),
  })
  .get(
    "/pets/:petId",
    ({ params, status }) =>
      pets.read(params.petId) ??
      status(404, {
        code: "NOT_FOUND",
        message: `Pet ${params.petId} not found`,
      }),
  )
  .delete("/pets/:petId", ({ params, status }) => {
    if (!pets.read(params.petId)) {
      return status(404, { code: "NOT_FOUND", message: `Pet ${params.petId} not found` });
    }
    pets.delete(params.petId);
    return status(204);
  })
  .listen({ port: benchmarkServerPort(3461), hostname: "127.0.0.1" });

console.log(`Elysia benchmark server running on http://127.0.0.1:${app.server!.port}`);
