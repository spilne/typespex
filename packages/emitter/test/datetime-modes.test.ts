import { Temporal } from "@js-temporal/polyfill";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  buildEmitter,
  cleanupFixtures,
  compileFixture,
  type CompileResult,
} from "./compile-fixture.js";

afterAll(cleanupFixtures);
beforeAll(buildEmitter);

const dateTimeSpec = `
import "@typespec/http";
using TypeSpec.Http;

@service(#{ title: "DateTimeApi" })
namespace DateTimeApi;

model DatePayload {
  date: plainDate;
  time: plainTime;
  utc: utcDateTime;
  offset: offsetDateTime;
  span: duration;
  @encode("unixTimestamp", int32) epoch: utcDateTime;
  @encode("seconds", float64) elapsed: duration;
  @encode("rfc7231") httpDate: offsetDateTime;
}

model DateResponse {
  @header("x-response-offset") @encode("rfc3339") responseOffset: offsetDateTime;
  @body body: DatePayload;
}

@route("/body")
@post
op body(@body body: DatePayload): DateResponse;

@route("/parameters/{date}")
@get
op parameters(
  @path date: plainDate,
  @query time: plainTime,
  @query span: duration,
  @header("x-utc") utc: utcDateTime,
  @header("x-offset") @encode("rfc3339") offset: offsetDateTime,
): void;
`;

const dateTimeNameCollisionSpec = `
import "@typespec/http";
using TypeSpec.Http;

@service namespace DateTimeNameCollisionApi {
  model Date { at: utcDateTime; }
  model Temporal { date: plainDate; }
  model Payload { instant: Date; calendar: Temporal; }

  @route("/payload")
  @post op write(@body body: Payload): Payload;
}
`;

const wirePayload = {
  date: "2024-02-29",
  time: "12:34:56.123456789",
  utc: "2024-01-02T03:04:05.123456789Z",
  offset: "2024-01-02T03:04:05.123456789+02:30",
  span: "P1M2DT3H4M5.006007008S",
  epoch: 0,
  elapsed: 1.5,
  httpDate: "Tue, 02 Jan 2024 03:04:05 GMT",
};

function parameterRequest(): Request {
  return new Request(
    "http://localhost/parameters/2024-02-29?time=12%3A34%3A56.123456789&span=PT2H",
    {
      headers: {
        "x-utc": "Tue, 02 Jan 2024 03:04:05 GMT",
        "x-offset": "2024-01-02T03:04:05+02:30",
      },
    },
  );
}

async function createRouter(
  result: CompileResult,
  onBody: (input: any) => DateResponseValue,
  onParameters: (input: any) => void,
): Promise<{ handle(request: Request): Promise<Response> }> {
  const { createDateTimeApiServerRouter } = await import(
    `${result.outputDir}/date-time-api/server-router.ts`
  );
  return createDateTimeApiServerRouter({ body: onBody, parameters: onParameters } as any);
}

interface DateResponseValue {
  readonly responseOffset: unknown;
  readonly body: unknown;
}

describe("configurable date-time handler mappings", () => {
  test("reserves mode globals without renaming unrelated user models", () => {
    const stringResult = compileFixture("datetime-name-string", dateTimeNameCollisionSpec);
    const stringModels = stringResult.readFile("date-time-name-collision-api", "models.ts");
    expect(stringModels).toContain("export interface Date");
    expect(stringModels).toContain("export interface Temporal");
    expect(stringModels).not.toContain("@js-temporal/polyfill");
    stringResult.typecheck("date-time-name-collision-api");

    const dateResult = compileFixture(
      "datetime-name-date",
      dateTimeNameCollisionSpec,
      "    datetime-mode: date\n",
    );
    const dateModels = dateResult.readFile("date-time-name-collision-api", "models.ts");
    expect(dateModels).toContain("export interface Model_Date");
    expect(dateModels).toContain("export interface Temporal");
    expect(dateModels).toContain("instant: Model_Date;");
    dateResult.typecheck("date-time-name-collision-api");

    const temporalResult = compileFixture(
      "datetime-name-temporal",
      dateTimeNameCollisionSpec,
      "    datetime-mode: temporal\n",
    );
    const temporalModels = temporalResult.readFile("date-time-name-collision-api", "models.ts");
    expect(temporalModels).toContain("export interface Date");
    expect(temporalModels).toContain("export interface Model_Temporal");
    expect(temporalModels).toContain("calendar: Model_Temporal;");
    expect(temporalModels).toContain('import type { Temporal } from "@js-temporal/polyfill";');
    temporalResult.typecheck("date-time-name-collision-api");
  }, 20_000);

  test("keeps strings as the backwards-compatible default", () => {
    const result = compileFixture("datetime-mode-string", dateTimeSpec);
    const models = result.readFile("date-time-api", "models.ts");
    const operations = result.readFile("date-time-api", "server-operations.ts");

    expect(models).toContain("date: string;");
    expect(models).toContain("utc: string;");
    expect(models).toContain("span: string;");
    expect(models).not.toContain("@js-temporal/polyfill");
    expect(operations).not.toContain("@js-temporal/polyfill");
    result.typecheck("date-time-api");
  });

  test("maps instant-bearing scalars to Date without adding a dependency", async () => {
    const result = compileFixture("datetime-mode-date", dateTimeSpec, "    datetime-mode: date\n");
    const models = result.readFile("date-time-api", "models.ts");
    const operations = result.readFile("date-time-api", "server-operations.ts");

    expect(models).toContain("date: string;");
    expect(models).toContain("time: string;");
    expect(models).toContain("utc: Date;");
    expect(models).toContain("offset: Date;");
    expect(models).toContain("span: string;");
    expect(operations).toContain("Decoders.dateTimeDate");
    expect(operations).toContain("JsonSerializers.transformInput");
    expect(operations).not.toContain("@js-temporal/polyfill");
    result.typecheck("date-time-api");

    let receivedBody: any;
    let receivedParameters: any;
    const router = await createRouter(
      result,
      (input) => {
        receivedBody = input;
        return { responseOffset: input.offset, body: input };
      },
      (input) => {
        receivedParameters = input;
      },
    );

    const bodyResponse = await router.handle(
      new Request("http://localhost/body", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(wirePayload),
      }),
    );
    expect(bodyResponse.status).toBe(200);
    expect(receivedBody.date).toBe(wirePayload.date);
    expect(receivedBody.time).toBe(wirePayload.time);
    expect(receivedBody.span).toBe(wirePayload.span);
    expect(receivedBody.utc).toBeInstanceOf(Date);
    expect(receivedBody.utc.toISOString()).toBe("2024-01-02T03:04:05.123Z");
    expect(receivedBody.offset).toBeInstanceOf(Date);
    expect(receivedBody.offset.toISOString()).toBe("2024-01-02T00:34:05.123Z");
    expect(receivedBody.epoch.toISOString()).toBe("1970-01-01T00:00:00.000Z");
    expect(receivedBody.elapsed).toBe("PT1.5S");
    expect(receivedBody.httpDate.toISOString()).toBe("2024-01-02T03:04:05.000Z");
    expect(bodyResponse.headers.get("x-response-offset")).toBe("2024-01-02T00:34:05.123Z");
    expect(await bodyResponse.json()).toEqual({
      ...wirePayload,
      utc: "2024-01-02T03:04:05.123Z",
      offset: "2024-01-02T00:34:05.123Z",
    });

    const parametersResponse = await router.handle(parameterRequest());
    expect(parametersResponse.status).toBe(204);
    expect(receivedParameters).toEqual({
      date: "2024-02-29",
      time: "12:34:56.123456789",
      span: "PT2H",
      utc: new Date("2024-01-02T03:04:05.000Z"),
      offset: new Date("2024-01-02T00:34:05.000Z"),
    });

    const leapSecondResponse = await router.handle(
      new Request("http://localhost/body", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...wirePayload, utc: "2016-12-31T23:59:60Z" }),
      }),
    );
    expect(leapSecondResponse.status).toBe(200);
    expect(receivedBody.utc.toISOString()).toBe("2017-01-01T00:00:00.000Z");
    expect(await leapSecondResponse.json()).toEqual({
      ...wirePayload,
      utc: "2017-01-01T00:00:00.000Z",
      offset: "2024-01-02T00:34:05.123Z",
    });
  });

  test("maps every date and duration scalar to its Temporal representation", async () => {
    const result = compileFixture(
      "datetime-mode-temporal",
      dateTimeSpec,
      "    datetime-mode: temporal\n",
    );
    const models = result.readFile("date-time-api", "models.ts");
    const server = result.readFile("date-time-api", "server.ts");
    const operations = result.readFile("date-time-api", "server-operations.ts");

    expect(models).toContain('import type { Temporal } from "@js-temporal/polyfill";');
    expect(models).toContain("date: Temporal.PlainDate;");
    expect(models).toContain("time: Temporal.PlainTime;");
    expect(models).toContain("utc: Temporal.Instant;");
    expect(models).toContain("offset: Temporal.ZonedDateTime;");
    expect(models).toContain("span: Temporal.Duration;");
    expect(server).toContain('import type { Temporal } from "@js-temporal/polyfill";');
    expect(operations).toContain('import { Temporal } from "@js-temporal/polyfill";');
    expect(operations).toContain("Decoders.transform");
    expect(operations).toContain("JsonSerializers.transformInput");
    result.typecheck("date-time-api");

    let receivedBody: any;
    let receivedParameters: any;
    let bodyCalls = 0;
    let returnMalformedBody = false;
    const router = await createRouter(
      result,
      (input) => {
        bodyCalls += 1;
        receivedBody = input;
        return {
          responseOffset: input.offset,
          body: returnMalformedBody ? { ...input, utc: wirePayload.utc } : input,
        };
      },
      (input) => {
        receivedParameters = input;
      },
    );

    const bodyResponse = await router.handle(
      new Request("http://localhost/body", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(wirePayload),
      }),
    );
    expect(bodyResponse.status).toBe(200);
    expect(receivedBody.date).toBeInstanceOf(Temporal.PlainDate);
    expect(receivedBody.time).toBeInstanceOf(Temporal.PlainTime);
    expect(receivedBody.utc).toBeInstanceOf(Temporal.Instant);
    expect(receivedBody.offset).toBeInstanceOf(Temporal.ZonedDateTime);
    expect(receivedBody.span).toBeInstanceOf(Temporal.Duration);
    expect(receivedBody.epoch.toString()).toBe("1970-01-01T00:00:00Z");
    expect(receivedBody.elapsed.toString()).toBe("PT1.5S");
    expect(receivedBody.offset.offset).toBe("+02:30");
    expect(bodyResponse.headers.get("x-response-offset")).toBe(wirePayload.offset);
    expect(await bodyResponse.json()).toEqual(wirePayload);

    const parametersResponse = await router.handle(parameterRequest());
    expect(parametersResponse.status).toBe(204);
    expect(receivedParameters.date).toBeInstanceOf(Temporal.PlainDate);
    expect(receivedParameters.time).toBeInstanceOf(Temporal.PlainTime);
    expect(receivedParameters.span).toBeInstanceOf(Temporal.Duration);
    expect(receivedParameters.utc).toBeInstanceOf(Temporal.Instant);
    expect(receivedParameters.offset).toBeInstanceOf(Temporal.ZonedDateTime);
    expect(receivedParameters.offset.offset).toBe("+02:30");

    returnMalformedBody = true;
    const malformed = await router.handle(
      new Request("http://localhost/body", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(wirePayload),
      }),
    );
    expect(malformed.status).toBe(500);

    const invalid = await router.handle(
      new Request("http://localhost/body", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...wirePayload, date: "2023-02-29" }),
      }),
    );
    expect(invalid.status).toBe(400);

    const unknownOffset = await router.handle(
      new Request("http://localhost/body", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ...wirePayload,
          offset: "2024-01-02T03:04:05-00:00",
        }),
      }),
    );
    expect(unknownOffset.status).toBe(400);
    expect(await unknownOffset.text()).toContain("unknown -00:00 offset");

    const leapSecond = await router.handle(
      new Request("http://localhost/body", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...wirePayload, utc: "2016-12-31T23:59:60Z" }),
      }),
    );
    expect(leapSecond.status).toBe(400);
    expect(await leapSecond.text()).toContain("leap-second date-time");
    expect(bodyCalls).toBe(2);
  });
});
