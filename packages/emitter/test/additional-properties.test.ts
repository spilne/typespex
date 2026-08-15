import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { buildEmitter, cleanupFixtures, compileFixture } from "./compile-fixture.js";

afterAll(cleanupFixtures);
beforeAll(buildEmitter);

const additionalPropertiesSpec = `
import "@typespec/http";
using TypeSpec.Http;

@service(#{ title: "AdditionalPropertiesApi" })
namespace AdditionalPropertiesApi;

model SpreadPerson {
  age: int32;
  ...Record<string>;
}

model IsStrings is Record<string> {
  name: string;
}

model ExtendsStrings extends Record<string> {
  name: string;
}

model PureStrings is Record<string>;

model PureClosed is Record<never>;

model Ordinary {
  name: string;
}

model Closed {
  name: string;
  ...Record<never>;
}

model RootAdditional {
  value: string;
  ...Record<string>;
}

model ProjectedOrdinary {
  @header("x-projected-trace") trace: string;
  value: string;
}

model GenericSpread<T> {
  known: T;
  ...Record<T>;
}

model GenericIs<T> is Record<T> {
  known: T;
}

model GenericPure<T> is Record<T>;

model GenericWrapper<T> {
  value: GenericSpread<T>;
}

model GenericMulti<L, R> {
  known: L;
  ...Record<L>;
  ...Record<R>;
}

model GenericIsWins<T, U> is Record<T> {
  known: T;
  ...Record<U>;
}

model GenericExtends<T> extends Record<T> {
  known: T;
}

model GenericSpreadThrough<T> {
  ...GenericSpread<T>;
}

model GenericClosed<T> {
  known: T;
  ...Record<never>;
}

@route("/spread")
@post
op spread(@body payload: SpreadPerson): void;

@route("/is")
@post
op isModel(@body payload: IsStrings): void;

@route("/extends")
@post
op extendsModel(@body payload: ExtendsStrings): void;

@route("/pure")
@post
op pure(@body payload: PureStrings): void;

@route("/pure-closed")
@post
op pureClosed(@body payload: PureClosed): void;

@route("/ordinary")
@post
op ordinary(@body payload: Ordinary): void;

@route("/closed")
@post
op closed(@body payload: Closed): void;

@route("/combined")
@post
op combined(@query id: string, @body payload: SpreadPerson): void;

@route("/root")
@post
op root(@header("x-trace") trace: string, @body payload: RootAdditional): void;

@route("/projected")
@post
op projected(@bodyRoot payload: ProjectedOrdinary): void;

@route("/generic-spread")
@post
op genericSpread(@body payload: GenericSpread<string>): void;

@route("/generic-is")
@post
op genericIs(@body payload: GenericIs<int32>): void;

@route("/generic-pure")
@post
op genericPure(@body payload: GenericPure<boolean>): void;

@route("/generic-nested")
@post
op genericNested(@body payload: GenericWrapper<string>): void;

@route("/generic-multi")
@post
op genericMulti(@body payload: GenericMulti<string, int32>): void;

@route("/generic-is-wins")
@post
op genericIsWins(@body payload: GenericIsWins<string, int32>): void;

@route("/generic-closed")
@post
op genericClosed(@body payload: GenericClosed<string>): void;
`;

function jsonRequest(path: string, body: unknown, headers: Record<string, string> = {}): Request {
  return new Request(`http://localhost${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

const additionalPropertiesUnionSpec = `
import "@typespec/http";
using TypeSpec.Http;

@service namespace AdditionalPropertiesUnionApi;

model WidgetData0 {
  kind: "kind0";
  @encodedName("application/json", "foo_prop")
  fooProp: string;
}

model WidgetData1 {
  kind: "kind1";
  start: utcDateTime;
  end?: utcDateTime;
}

model WidgetData2 {
  kind: "kind1";
  start: string;
}

model ByRequiredProperty {
  name: string;
  ...Record<WidgetData0 | WidgetData1>;
}

model ByOptionalProperty {
  name: string;
  ...Record<WidgetData2 | WidgetData1>;
}

model ByContainerShape {
  name: string;
  ...Record<WidgetData2[] | WidgetData1>;
}

@route("/required") @get op required(): ByRequiredProperty;
@route("/optional") @get op optional(): ByOptionalProperty;
@route("/container") @get op container(): ByContainerShape;
`;

describe("TypeSpec model additional properties", () => {
  test("emits and decodes declared and additional properties independently", async () => {
    const result = compileFixture("additional-properties", additionalPropertiesSpec);
    const models = result.readFile("additional-properties-api", "models.ts");
    const server = result.readFile("additional-properties-api", "server.ts");
    const operations = result.readFile("additional-properties-api", "server-operations.ts");

    for (const model of ["SpreadPerson", "IsStrings", "ExtendsStrings", "Ordinary", "Closed"]) {
      expect(models).toContain(`export interface ${model}`);
    }
    expect(models).toMatch(
      /export interface SpreadPerson \{[\s\S]*age: number;[\s\S]*\[key: string\]: (?:string \| number|number \| string);[\s\S]*\}/,
    );
    expect(models).toMatch(
      /export interface IsStrings \{[\s\S]*name: string;[\s\S]*\[key: string\]: string;[\s\S]*\}/,
    );
    expect(models).toMatch(
      /export interface ExtendsStrings \{[\s\S]*name: string;[\s\S]*\[key: string\]: string;[\s\S]*\}/,
    );
    expect(models).not.toMatch(/export interface Ordinary \{[^}]*\[key: string\]/);
    expect(models).not.toMatch(/export interface Closed \{[^}]*\[key: string\]/);
    expect(models).toMatch(
      /export interface GenericSpread<T> \{[\s\S]*known: T;[\s\S]*\[key: string\]: T;[\s\S]*\}/,
    );
    expect(models).toMatch(
      /export interface GenericIs<T> \{[\s\S]*known: T;[\s\S]*\[key: string\]: T;[\s\S]*\}/,
    );
    expect(models).not.toContain("export interface GenericPure");
    expect(models).toMatch(
      /export interface GenericWrapper<T> \{[\s\S]*value: GenericSpread<T>;[\s\S]*\}/,
    );
    expect(models).toMatch(
      /export interface GenericMulti<L, R> \{[\s\S]*known: L;[\s\S]*\[key: string\]: (?:L \| R|R \| L);[\s\S]*\}/,
    );
    expect(models).toMatch(
      /export interface GenericIsWins<T, U> \{[\s\S]*known: T;[\s\S]*\[key: string\]: T;[\s\S]*\}/,
    );
    expect(models).toMatch(
      /export interface GenericExtends<T> \{[\s\S]*known: T;[\s\S]*\[key: string\]: T;[\s\S]*\}/,
    );
    expect(models).toMatch(
      /export interface GenericSpreadThrough<T> \{[\s\S]*known: T;[\s\S]*\[key: string\]: T;[\s\S]*\}/,
    );
    expect(models).not.toMatch(/export interface GenericClosed<T> \{[^}]*\[key: string\]/);
    expect(server).toContain(
      "readonly combined: OperationHandler<{ id: string; body: SpreadPerson }, void, Ctx>",
    );
    expect(operations).toContain("additionalProperties: Decoders.string");
    expect(operations).toContain("allowUnknown: true");
    expect(operations).toContain("Decoders.record(Decoders.string)");
    expect(operations).toContain("Decoders.record(Decoders.never)");
    expect(operations).toContain('forbiddenProperties: ["trace"]');
    result.typecheck("additional-properties-api", {
      "additional-property-types.ts": `
import type {
  ExtendsStrings,
  GenericIs,
  GenericIsWins,
  GenericMulti,
  GenericSpread,
  GenericWrapper,
  IsStrings,
  SpreadPerson,
} from "./models.js";
import { Decoders } from "@typespex/runtime/server";

const spread: SpreadPerson = { age: 42, note: "kept" };
const spreadValue: string | number = spread["note"];
const viaIs: IsStrings = { name: "Ada", note: "kept" };
const viaExtends: ExtendsStrings = { name: "Grace", note: "kept" };
const genericSpread: GenericSpread<string> = { known: "yes", note: "kept" };
const genericIs: GenericIs<number> = { known: 1, extra: 2 };
const genericWrapper: GenericWrapper<string> = {
  value: { known: "yes", nestedExtra: "kept" },
};
const genericValue: string = genericSpread["note"];
const genericMulti: GenericMulti<string, number> = {
  known: "yes",
  text: "kept",
  count: 2,
};
const genericIsWins: GenericIsWins<string, number> = {
  known: "yes",
  text: "kept",
};
// @ts-expect-error Additional SpreadPerson values must match the emitted index union.
const invalidSpread: SpreadPerson = { age: 42, invalid: true };
// @ts-expect-error Generic additional values must match their type argument.
const invalidGeneric: GenericSpread<string> = { known: "yes", invalid: true };
// @ts-expect-error A model's \`is Record<T>\` source is authoritative over later spreads.
const invalidGenericIs: GenericIsWins<string, number> = { known: "yes", invalid: 1 };
const numericAdditionalDecoder = Decoders.object<Record<string, number>>(
  {},
  { additionalProperties: Decoders.number },
);
const invalidAdditionalDecoder = Decoders.object<Record<string, number>>(
  {},
  // @ts-expect-error The additional-property decoder must match the declared index value.
  { additionalProperties: Decoders.string },
);

void spreadValue;
void viaIs;
void viaExtends;
void genericIs;
void genericWrapper;
void genericValue;
void genericMulti;
void genericIsWins;
void invalidSpread;
void invalidGeneric;
void invalidGenericIs;
void numericAdditionalDecoder;
void invalidAdditionalDecoder;
`,
    });

    const { createAdditionalPropertiesApiServerRouter } = await import(
      `${result.outputDir}/additional-properties-api/server-router.ts`
    );
    const received = new Map<string, unknown[]>();
    const capture = (operation: string) => (input: unknown) => {
      const calls = received.get(operation) ?? [];
      calls.push(input);
      received.set(operation, calls);
    };
    const router = createAdditionalPropertiesApiServerRouter({
      spread: capture("spread"),
      isModel: capture("isModel"),
      extendsModel: capture("extendsModel"),
      pure: capture("pure"),
      pureClosed: capture("pureClosed"),
      ordinary: capture("ordinary"),
      closed: capture("closed"),
      combined: capture("combined"),
      root: capture("root"),
      projected: capture("projected"),
      genericSpread: capture("genericSpread"),
      genericIs: capture("genericIs"),
      genericPure: capture("genericPure"),
      genericNested: capture("genericNested"),
      genericMulti: capture("genericMulti"),
      genericIsWins: capture("genericIsWins"),
      genericClosed: capture("genericClosed"),
    } as any);

    const spread = JSON.parse(
      '{"age":42,"note":"kept","__proto__":"proto-value","constructor":"constructor-value"}',
    );
    expect((await router.handle(jsonRequest("/spread", spread))).status).toBe(204);
    const spreadInput = received.get("spread")?.[0] as Record<string, unknown>;
    expect(spreadInput).toEqual(spread);
    expect(Object.prototype.hasOwnProperty.call(spreadInput, "__proto__")).toBe(true);
    expect(Object.prototype.hasOwnProperty.call(spreadInput, "constructor")).toBe(true);

    expect((await router.handle(jsonRequest("/spread", { note: "missing-age" }))).status).toBe(400);
    expect(
      (await router.handle(jsonRequest("/spread", { age: "42", note: "wrong-age" }))).status,
    ).toBe(400);
    expect((await router.handle(jsonRequest("/spread", { age: 42, note: 123 }))).status).toBe(400);

    expect((await router.handle(jsonRequest("/is", { name: "Ada", note: "kept" }))).status).toBe(
      204,
    );
    expect(received.get("isModel")).toEqual([{ name: "Ada", note: "kept" }]);

    expect(
      (await router.handle(jsonRequest("/extends", { name: "Grace", note: "kept" }))).status,
    ).toBe(204);
    expect(received.get("extendsModel")).toEqual([{ name: "Grace", note: "kept" }]);

    expect(
      (await router.handle(jsonRequest("/pure", { first: "one", second: "two" }))).status,
    ).toBe(204);
    expect(received.get("pure")).toEqual([{ first: "one", second: "two" }]);
    expect((await router.handle(jsonRequest("/pure", { invalid: 1 }))).status).toBe(400);

    expect((await router.handle(jsonRequest("/pure-closed", {}))).status).toBe(204);
    expect((await router.handle(jsonRequest("/pure-closed", { invalid: true }))).status).toBe(400);
    expect(received.get("pureClosed")).toEqual([{}]);

    expect(
      (await router.handle(jsonRequest("/ordinary", { name: "ordinary", ignored: true }))).status,
    ).toBe(204);
    expect(received.get("ordinary")).toEqual([{ name: "ordinary" }]);

    expect((await router.handle(jsonRequest("/closed", { name: "closed" }))).status).toBe(204);
    expect(
      (await router.handle(jsonRequest("/closed", { name: "closed", invalid: true }))).status,
    ).toBe(400);
    expect(received.get("closed")).toEqual([{ name: "closed" }]);

    expect(
      (
        await router.handle(
          jsonRequest("/combined?id=query-id", {
            age: 42,
            id: "body-id",
            note: "kept",
          }),
        )
      ).status,
    ).toBe(204);
    expect(received.get("combined")).toEqual([
      {
        id: "query-id",
        body: { age: 42, id: "body-id", note: "kept" },
      },
    ]);

    expect(
      (
        await router.handle(
          jsonRequest(
            "/root",
            { value: "root", extra: "kept", trace: "body-trace" },
            { "x-trace": "header-trace" },
          ),
        )
      ).status,
    ).toBe(204);
    expect(received.get("root")).toEqual([
      {
        trace: "header-trace",
        body: { value: "root", extra: "kept", trace: "body-trace" },
      },
    ]);
    expect(
      (
        await router.handle(
          jsonRequest(
            "/projected",
            { value: "projected", ignored: "ordinary-extra" },
            { "x-projected-trace": "header-trace" },
          ),
        )
      ).status,
    ).toBe(204);
    expect(received.get("projected")).toEqual([
      {
        trace: "header-trace",
        value: "projected",
      },
    ]);
    expect(
      (
        await router.handle(
          jsonRequest(
            "/projected",
            { value: "projected", trace: "must-not-come-from-json" },
            { "x-projected-trace": "header-trace" },
          ),
        )
      ).status,
    ).toBe(400);

    expect(
      (await router.handle(jsonRequest("/generic-spread", { known: "yes", extra: "preserved" })))
        .status,
    ).toBe(204);
    expect(received.get("genericSpread")).toEqual([{ known: "yes", extra: "preserved" }]);
    expect(
      (await router.handle(jsonRequest("/generic-spread", { known: "yes", invalid: 1 }))).status,
    ).toBe(400);

    expect((await router.handle(jsonRequest("/generic-is", { known: 1, extra: 2 }))).status).toBe(
      204,
    );
    expect(received.get("genericIs")).toEqual([{ known: 1, extra: 2 }]);
    expect(
      (await router.handle(jsonRequest("/generic-is", { known: 1, invalid: "two" }))).status,
    ).toBe(400);

    expect(
      (await router.handle(jsonRequest("/generic-pure", { enabled: true, visible: false }))).status,
    ).toBe(204);
    expect(received.get("genericPure")).toEqual([{ enabled: true, visible: false }]);

    expect(
      (
        await router.handle(
          jsonRequest("/generic-nested", {
            value: { known: "yes", nestedExtra: "preserved" },
          }),
        )
      ).status,
    ).toBe(204);
    expect(received.get("genericNested")).toEqual([
      { value: { known: "yes", nestedExtra: "preserved" } },
    ]);

    expect(
      (
        await router.handle(
          jsonRequest("/generic-multi", {
            known: "yes",
            text: "preserved",
            count: 2,
          }),
        )
      ).status,
    ).toBe(204);
    expect(received.get("genericMulti")).toEqual([{ known: "yes", text: "preserved", count: 2 }]);
    expect(
      (await router.handle(jsonRequest("/generic-multi", { known: "yes", invalid: true }))).status,
    ).toBe(400);

    expect(
      (await router.handle(jsonRequest("/generic-is-wins", { known: "yes", extra: "preserved" })))
        .status,
    ).toBe(204);
    expect(received.get("genericIsWins")).toEqual([{ known: "yes", extra: "preserved" }]);
    expect(
      (await router.handle(jsonRequest("/generic-is-wins", { known: "yes", invalid: 1 }))).status,
    ).toBe(400);

    expect(
      (await router.handle(jsonRequest("/generic-closed", { known: "yes", invalid: true }))).status,
    ).toBe(400);
  });

  test("serializes structurally distinct unions in additional properties", async () => {
    const result = compileFixture("additional-properties-unions", additionalPropertiesUnionSpec);
    const operations = result.readFile("additional-properties-union-api", "server-operations.ts");

    expect(operations).toContain("JsonSerializers.union<");
    expect(operations).toContain("JsonSerializers.exactObject(");
    expect(operations).toContain('JsonSerializers.literal("kind0")');
    expect(operations).toContain('wireName: "foo_prop"');
    result.typecheck("additional-properties-union-api");

    const { createAdditionalPropertiesUnionApiServerRouter } = await import(
      `${result.outputDir}/additional-properties-union-api/server-router.ts`
    );
    const router = createAdditionalPropertiesUnionApiServerRouter({
      required: () => ({
        name: "required",
        first: { kind: "kind0", fooProp: "renamed" },
        second: {
          kind: "kind1",
          start: "2021-01-01T00:00:00Z",
          end: "2021-01-02T00:00:00Z",
        },
      }),
      optional: () => ({
        name: "optional",
        text: { kind: "kind1", start: "plain text" },
        overlap: { kind: "kind1", start: "2021-01-01T00:00:00Z" },
        dated: {
          kind: "kind1",
          start: "2021-01-01T00:00:00Z",
          end: "2021-01-02T00:00:00Z",
        },
      }),
      container: () => ({
        name: "container",
        list: [{ kind: "kind1", start: "plain text" }],
        object: { kind: "kind1", start: "2021-01-01T00:00:00Z" },
      }),
    });

    const required = await router.handle(new Request("http://localhost/required"));
    expect(required.status).toBe(200);
    expect(await required.json()).toEqual({
      name: "required",
      first: { kind: "kind0", foo_prop: "renamed" },
      second: {
        kind: "kind1",
        start: "2021-01-01T00:00:00Z",
        end: "2021-01-02T00:00:00Z",
      },
    });

    const optional = await router.handle(new Request("http://localhost/optional"));
    expect(optional.status).toBe(200);
    expect(await optional.json()).toEqual({
      name: "optional",
      text: { kind: "kind1", start: "plain text" },
      overlap: { kind: "kind1", start: "2021-01-01T00:00:00Z" },
      dated: {
        kind: "kind1",
        start: "2021-01-01T00:00:00Z",
        end: "2021-01-02T00:00:00Z",
      },
    });

    const container = await router.handle(new Request("http://localhost/container"));
    expect(container.status).toBe(200);
    expect(await container.json()).toEqual({
      name: "container",
      list: [{ kind: "kind1", start: "plain text" }],
      object: { kind: "kind1", start: "2021-01-01T00:00:00Z" },
    });
  });
});
