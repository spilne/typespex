import { describe, expect, test } from "bun:test";
import {
  executeHttpRequest,
  HttpClientError,
  readBoundedBody,
  readBoundedJsonLines,
} from "../src/index.js";

describe("protocol-neutral HTTP client", () => {
  test("follows bounded redirects and strips credentials", async () => {
    const requests: Request[] = [];
    let redirectBodyCanceled = false;
    const fetchMock = async (input: string | URL | Request, init?: RequestInit) => {
      const request = new Request(input, init);
      requests.push(request);
      return requests.length === 1
        ? new Response(
            new ReadableStream({
              start(controller) {
                controller.enqueue(new Uint8Array([1]));
              },
              cancel() {
                redirectBodyCanceled = true;
              },
            }),
            { status: 307, headers: { Location: "/next?api_key=secret" } },
          )
        : Response.json({ ok: true });
    };
    const response = await executeHttpRequest(
      "https://api.example.test/start?api_key=secret",
      { headers: { Authorization: "Bearer secret", Cookie: "session=secret" } },
      {
        fetch: fetchMock as typeof fetch,
        sensitiveQueryParameters: ["api_key"],
      },
    );

    expect(response.status).toBe(200);
    expect(requests).toHaveLength(2);
    expect(requests[1]!.headers.has("Authorization")).toBe(false);
    expect(requests[1]!.headers.has("Cookie")).toBe(false);
    expect(new URL(requests[1]!.url).searchParams.has("api_key")).toBe(false);
    expect(redirectBodyCanceled).toBe(true);
  });

  test("preserves same-origin credentials only when explicitly enabled", async () => {
    const requests: Request[] = [];
    const fetchMock = async (input: string | URL | Request, init?: RequestInit) => {
      const request = new Request(input, init);
      requests.push(request);
      return requests.length === 1
        ? new Response(null, { status: 303, headers: { Location: "/next" } })
        : new Response(null, { status: 204 });
    };

    await executeHttpRequest(
      "https://api.example.test/start",
      { method: "HEAD", headers: { Authorization: "Bearer secret" } },
      {
        fetch: fetchMock as typeof fetch,
        preserveSensitiveHeadersOnSameOriginRedirects: true,
      },
    );

    expect(requests).toHaveLength(2);
    expect(requests[1]!.method).toBe("HEAD");
    expect(requests[1]!.headers.get("Authorization")).toBe("Bearer secret");
  });

  test("always strips credentials from allowlisted cross-origin redirects", async () => {
    const requests: Request[] = [];
    const fetchMock = async (input: string | URL | Request, init?: RequestInit) => {
      const request = new Request(input, init);
      requests.push(request);
      return requests.length === 1
        ? new Response(null, {
            status: 307,
            headers: { Location: "https://other.test/next" },
          })
        : new Response(null, { status: 204 });
    };

    await executeHttpRequest(
      "https://api.example.test/start",
      { headers: { Authorization: "Bearer secret" } },
      {
        fetch: fetchMock as typeof fetch,
        allowedRedirectOrigins: ["https://other.test"],
        preserveSensitiveHeadersOnSameOriginRedirects: true,
      },
    );

    expect(requests[1]!.headers.has("Authorization")).toBe(false);
  });

  test("rejects cross-origin redirects unless allowlisted", async () => {
    let redirectBodyCanceled = false;
    const fetchMock = async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new Uint8Array([1]));
          },
          cancel() {
            redirectBodyCanceled = true;
          },
        }),
        { status: 302, headers: { Location: "https://other.test/value" } },
      );
    const rejected = executeHttpRequest(
      "https://api.example.test/start",
      {},
      {
        fetch: fetchMock as typeof fetch,
        maxRedirects: 1,
      },
    );
    await expect(rejected).rejects.toMatchObject<HttpClientError>({ code: "redirect-origin" });
    expect(redirectBodyCanceled).toBe(true);
  });

  test("rejects redirects that would replay a streaming request body", async () => {
    const fetchMock = async () =>
      new Response(null, { status: 307, headers: { Location: "/next" } });
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("value"));
        controller.close();
      },
    });

    await expect(
      executeHttpRequest(
        "https://api.example.test/start",
        { method: "POST", body, duplex: "half" } as RequestInit,
        { fetch: fetchMock as typeof fetch },
      ),
    ).rejects.toMatchObject<HttpClientError>({ code: "redirect-body" });
  });

  test("rejects redirects that would replay an async-iterable request body", async () => {
    const fetchMock = async () =>
      new Response(null, { status: 308, headers: { Location: "/next" } });
    const body = {
      async *[Symbol.asyncIterator]() {
        yield new TextEncoder().encode("value");
      },
    };

    await expect(
      executeHttpRequest(
        "https://api.example.test/start",
        { method: "PUT", body, duplex: "half" } as unknown as RequestInit,
        { fetch: fetchMock as typeof fetch },
      ),
    ).rejects.toMatchObject<HttpClientError>({ code: "redirect-body" });
  });

  test("validates request URLs and bounds the response-header wait", async () => {
    await expect(executeHttpRequest("file:///tmp/value")).rejects.toMatchObject<HttpClientError>({
      code: "invalid-url",
    });
    await expect(
      executeHttpRequest("https://user:secret@api.example.test/value"),
    ).rejects.toMatchObject<HttpClientError>({ code: "invalid-url" });

    const fetchMock = async (_input: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        const onAbort = () => reject(init?.signal?.reason);
        if (init?.signal?.aborted) onAbort();
        else init?.signal?.addEventListener("abort", onAbort, { once: true });
      });
    await expect(
      executeHttpRequest(
        "https://api.example.test/value",
        {},
        {
          fetch: fetchMock as typeof fetch,
          headersTimeoutMs: 5,
        },
      ),
    ).rejects.toMatchObject<HttpClientError>({ code: "timeout" });
  });

  test("bounds response bytes and JSONL items", async () => {
    let byteBodyCanceled = false;
    const byteResponse = new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("12345"));
        },
        cancel() {
          byteBodyCanceled = true;
        },
      }),
    );
    await expect(readBoundedBody(byteResponse, 4)).rejects.toMatchObject<HttpClientError>({
      code: "body-limit",
    });
    expect(byteBodyCanceled).toBe(true);

    let jsonlBodyCanceled = false;
    const jsonlResponse = new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"id":1}\n{"id":2}\n'));
        },
        cancel() {
          jsonlBodyCanceled = true;
        },
      }),
    );
    await expect(
      readBoundedJsonLines(jsonlResponse, {
        maximumItems: 1,
        maximumBytes: 1024,
      }),
    ).rejects.toMatchObject<HttpClientError>({ code: "jsonl-item-limit" });
    expect(jsonlBodyCanceled).toBe(true);
    expect(
      await readBoundedJsonLines(new Response('{"id":1}\n{"id":2}\n'), {
        maximumItems: 2,
        maximumBytes: 1024,
      }),
    ).toEqual([{ id: 1 }, { id: 2 }]);
  });

  test("cancels a stalled body read when its signal aborts", async () => {
    let bodyCanceled = false;
    const response = new Response(
      new ReadableStream({
        cancel() {
          bodyCanceled = true;
        },
      }),
    );
    const controller = new AbortController();
    const reading = readBoundedBody(response, 1024, controller.signal);
    controller.abort(new Error("stop"));

    await expect(reading).rejects.toMatchObject<HttpClientError>({ code: "cancelled" });
    expect(bodyCanceled).toBe(true);
  });
});
