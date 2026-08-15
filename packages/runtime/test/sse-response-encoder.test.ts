import { describe, expect, test } from "bun:test";
import { ResponseEncoders, type SseEvent } from "../src/server.js";

describe("SSE response encoder", () => {
  test("frames named and unnamed events", async () => {
    async function* events(): AsyncGenerator<SseEvent> {
      yield { data: '{"desc":"one"}' };
      yield { event: "responseDelta", data: '{"delta":"Hello"}' };
    }

    const response = ResponseEncoders.sse(201).encode(events());

    expect(response.status).toBe(201);
    expect(response.headers.get("content-type")).toBe("text/event-stream; charset=utf-8");
    expect(await response.text()).toBe(
      'data: {"desc":"one"}\n\n' + 'event: responseDelta\ndata: {"delta":"Hello"}\n\n',
    );
  });

  test("transforms values and emits every normalized data line", async () => {
    async function* values() {
      yield { kind: "update", text: "first\r\nsecond\rthird\n" };
    }

    const response = ResponseEncoders.sse<{ kind: string; text: string }>(200, (value) => ({
      event: value.kind,
      data: value.text,
    })).encode(values());

    expect(await response.text()).toBe(
      "event: update\ndata: first\ndata: second\ndata: third\ndata: \n\n",
    );
  });

  test("emits a terminal event and closes the source before later values", async () => {
    let closed = false;
    async function* events(): AsyncGenerator<SseEvent> {
      try {
        yield { event: "delta", data: "one" };
        yield { data: "[DONE]", terminal: true };
        yield { event: "delta", data: "unreachable" };
      } finally {
        closed = true;
      }
    }

    const response = ResponseEncoders.sse().encode(events());

    expect(await response.text()).toBe("event: delta\ndata: one\n\ndata: [DONE]\n\n");
    expect(closed).toBe(true);
  });

  test("delivers a terminal frame before waiting for source cleanup", async () => {
    let signalReturnStarted!: () => void;
    let releaseReturn!: () => void;
    const returnStarted = new Promise<void>((resolve) => {
      signalReturnStarted = resolve;
    });
    const returnReleased = new Promise<void>((resolve) => {
      releaseReturn = resolve;
    });
    const events: AsyncIterable<SseEvent> = {
      [Symbol.asyncIterator]() {
        return {
          async next() {
            return { done: false as const, value: { data: "[DONE]", terminal: true } };
          },
          async return() {
            signalReturnStarted();
            await returnReleased;
            return { done: true as const, value: undefined };
          },
        };
      },
    };

    const reader = ResponseEncoders.sse().encode(events).body!.getReader();
    let delivered = false;
    const firstRead = reader.read().then((result) => {
      delivered = true;
      return result;
    });

    await returnStarted;
    await Promise.resolve();
    const deliveredBeforeCleanup = delivered;
    releaseReturn();

    const first = await firstRead;
    expect(deliveredBeforeCleanup).toBe(true);
    expect(new TextDecoder().decode(first.value)).toBe("data: [DONE]\n\n");
    expect((await reader.read()).done).toBe(true);
  });

  test("applies backpressure and closes a canceled source", async () => {
    let nextCalls = 0;
    let returned = false;
    const events: AsyncIterable<SseEvent> = {
      [Symbol.asyncIterator]() {
        return {
          async next() {
            nextCalls += 1;
            return { done: false as const, value: { data: String(nextCalls) } };
          },
          async return() {
            returned = true;
            return { done: true as const, value: undefined };
          },
        };
      },
    };

    const response = ResponseEncoders.sse().encode(events);
    const reader = response.body!.getReader();

    expect(nextCalls).toBe(0);
    expect(new TextDecoder().decode((await reader.read()).value)).toBe("data: 1\n\n");
    expect(nextCalls).toBe(1);

    await reader.cancel();
    expect(returned).toBe(true);
    expect(nextCalls).toBe(1);
  });

  test("surfaces transform failures and closes the source", async () => {
    let closed = false;
    async function* values() {
      try {
        yield "broken";
      } finally {
        closed = true;
      }
    }

    const response = ResponseEncoders.sse<string>(200, () => {
      throw new Error("cannot serialize event");
    }).encode(values());

    await expect(response.text()).rejects.toThrow("cannot serialize event");
    expect(closed).toBe(true);
  });

  test("validates event fields and closes the source after framing failures", async () => {
    const invalidEvents = [
      { event: "bad\nname", data: "value" },
      { event: "bad\0name", data: "value" },
      { data: 42 },
      { data: "value", terminal: "yes" },
      null,
    ];

    for (const invalidEvent of invalidEvents) {
      let closed = false;
      async function* events() {
        try {
          yield invalidEvent as unknown as SseEvent;
        } finally {
          closed = true;
        }
      }

      const response = ResponseEncoders.sse().encode(events());
      await expect(response.text()).rejects.toThrow();
      expect(closed).toBe(true);
    }
  });

  test("validates sources unless the status forbids a body", async () => {
    expect(() => ResponseEncoders.sse().encode([] as unknown as AsyncIterable<SseEvent>)).toThrow(
      "AsyncIterable",
    );

    const response = ResponseEncoders.sse(204).encode(
      undefined as unknown as AsyncIterable<SseEvent>,
    );
    expect(response.headers.get("content-type")).toBeNull();
    expect(await response.text()).toBe("");
  });
});
