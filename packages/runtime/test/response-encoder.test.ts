import { describe, expect, test } from "bun:test";
import { ResponseEncoders } from "../src/server.js";

describe("http response encoders", () => {
  test("ResponseEncoders.json encodes typed output as JSON", async () => {
    const encoder = ResponseEncoders.json<{ id: string }>(201);
    const response = encoder.encode({ id: "p-1" });

    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ id: "p-1" });
  });

  test("ResponseEncoders.empty encodes no body", async () => {
    const response = ResponseEncoders.empty(204).encode(undefined);

    expect(response.status).toBe(204);
    expect(await response.text()).toBe("");
  });

  test("ResponseEncoder.mapInput adapts output before encoding", async () => {
    const encoder = ResponseEncoders
      .json<{ name: string }>(200)
      .mapInput((value: { petName: string }) => ({ name: value.petName }));

    const response = encoder.encode({ petName: "Milo" });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ name: "Milo" });
  });

  test("ResponseEncoders.text, bytes, and response cover non-json responses", async () => {
    const text = ResponseEncoders.text(202).encode("accepted");
    expect(text.status).toBe(202);
    expect(await text.text()).toBe("accepted");

    const bytes = ResponseEncoders.bytes(200).encode(new Uint8Array([65, 66]));
    expect(bytes.status).toBe(200);
    expect(await bytes.text()).toBe("AB");

    const raw = new Response("raw", { status: 209 });
    expect(ResponseEncoders.response().encode(raw)).toBe(raw);
  });
});
