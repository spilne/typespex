import { afterAll, beforeAll, expect, test } from "bun:test";
import { appendFileSync } from "node:fs";
import { Decoders, Validators } from "../../http-server/src/index.js";
import { buildEmitter, cleanupFixtures, compileFixture } from "./compile-fixture.js";

afterAll(cleanupFixtures);
beforeAll(buildEmitter, 120_000);

const spec = `
import "@typespec/http";
using TypeSpec.Http;
@service namespace NestedApi;
enum Tier { Gold: "gold", Silver: "silver" }
model Customer { name: string; email: string; tier: Tier; }
model Address { street: string; city: string; @minLength(2) @maxLength(2) country: string; }
@maxItems(3) model Ratings is float64[];
model Item {
  @minLength(1) @maxLength(32) sku: string;
  name: string;
  @minValue(1) quantity: int32;
  unitPrice: float64;
  tags: string[];
  gift?: boolean;
}
model Order {
  @minLength(1) id: string;
  customer: Customer;
  shipping?: Address;
  @minItems(1) @maxItems(20) items: Item[];
  notes?: string;
  priority?: int32;
  status: "open" | "paid";
  ratings: Ratings;
  matrix: int32[][];
  parent: Order | null;
}
interface Orders {
  @route("/orders") @post create(@body body: Order): void;
}
`;

test("nested generated decoders agree with the generic decoders on every input", async () => {
  const result = compileFixture("nested-object", spec);
  result.typecheck("nested-api");
  const source = result.readFile("nested-api", "server-operations.ts");
  expect(source).toContain("value3Items");
  expect(source).toContain("value8ItemItems");
  expect(source).toMatch(/value\d+ === "open" \|\| value\d+ === "paid"/);
  // Each nested decoder is generated once per Order body and shared by the
  // element checks and the array fallbacks; the recursive Order body itself is
  // emitted inline and again as the lazy decoder behind "parent".
  expect(source.split("Decoder.of<Order>(").length - 1).toBe(2);
  for (const model of ["Customer", "Address", "Item"]) {
    expect(source.split(`Decoder.of<${model}>(`).length - 1).toBe(2);
  }
  appendFileSync(
    `${result.outputDir}/nested-api/server-operations.ts`,
    "\nexport { OrdersInput };\n",
  );
  const { OrdersInput } = await import(`${result.outputDir}/nested-api/server-operations.ts`);
  const actual = OrdersInput.create.json;

  const int32 = (...extra: Parameters<typeof Decoders.strictInteger.validate>) =>
    Decoders.strictInteger
      .validate(Validators.minValue(-2147483648), Validators.maxValue(2147483647))
      .validate(...extra);
  const customer = Decoders.object<any>(
    {
      name: Decoders.string,
      email: Decoders.string,
      tier: Decoders.union([Decoders.strictLiteral("gold"), Decoders.strictLiteral("silver")]),
    },
    { allowUnknown: true },
  );
  const address = Decoders.object<any>(
    {
      street: Decoders.string,
      city: Decoders.string,
      country: Decoders.string.validate(Validators.minLength(2), Validators.maxLength(2)),
    },
    { allowUnknown: true },
  );
  const item = Decoders.object<any>(
    {
      sku: Decoders.string.validate(Validators.minLength(1), Validators.maxLength(32)),
      name: Decoders.string,
      quantity: int32(Validators.minValue(1)),
      unitPrice: Decoders.strictNumber,
      tags: Decoders.strictArray(Decoders.string),
      gift: Decoders.optional(Decoders.strictBoolean),
    },
    { allowUnknown: true },
  );
  const order: ReturnType<typeof Decoders.object<any>> = Decoders.lazy(() =>
    Decoders.object<any>(
      {
        id: Decoders.string.validate(Validators.minLength(1)),
        customer,
        shipping: Decoders.optional(address),
        items: Decoders.strictArray(item).validate(Validators.minItems(1), Validators.maxItems(20)),
        notes: Decoders.optional(Decoders.string),
        priority: Decoders.optional(int32()),
        status: Decoders.union([Decoders.strictLiteral("open"), Decoders.strictLiteral("paid")]),
        ratings: Decoders.strictArray(Decoders.strictNumber).validate(Validators.maxItems(3)),
        matrix: Decoders.strictArray(Decoders.strictArray(int32())),
        parent: Decoders.union([order, Decoders.strictLiteral(null)]),
      },
      { allowUnknown: true },
    ),
  );

  const valid = {
    id: "order-1",
    customer: { name: "Ada", email: "ada@example.com", tier: "gold", extra: true },
    shipping: { street: "1 Way", city: "London", country: "GB" },
    items: [
      { sku: "SKU-1", name: "Item", quantity: 1, unitPrice: 9.99, tags: ["a", "b"] },
      { sku: "SKU-2", name: "Item 2", quantity: 2, unitPrice: 1, tags: [], gift: true },
    ],
    notes: "Leave at the door",
    priority: 2,
    status: "open",
    ratings: [1.5, 2],
    matrix: [[1, 2], []],
    parent: null,
  };
  const variants: unknown[] = [
    valid,
    null,
    undefined,
    [],
    "text",
    1,
    Object.create({ ...valid }),
    Object.assign(Object.create(null), valid),
    { ...valid, parent: { ...valid, parent: null } },
    { ...valid, parent: { ...valid, parent: { ...valid, status: "closed" } } },
    { ...valid, parent: undefined },
    { ...valid, id: "" },
    { ...valid, id: 5 },
    { ...valid, customer: null },
    { ...valid, customer: { name: "Ada", email: "e", tier: "bronze" } },
    { ...valid, customer: { name: 1, email: 2, tier: "gold" } },
    { ...valid, shipping: undefined },
    { ...valid, shipping: null },
    { ...valid, shipping: { street: "s", city: "c", country: "GBR" } },
    { ...valid, items: [] },
    { ...valid, items: "none" },
    { ...valid, items: Array.from({ length: 21 }, () => valid.items[0]) },
    {
      ...valid,
      items: [
        valid.items[0],
        null,
        3,
        { sku: "", name: "n", quantity: 0, unitPrice: "x", tags: ["a", 1] },
      ],
    },
    {
      ...valid,
      items: [
        { sku: "SKU", name: "n", quantity: 1.5, unitPrice: Infinity, tags: "a", gift: "yes" },
      ],
    },
    { ...valid, items: Object.assign(new Array(2), { 0: valid.items[0] }) },
    { ...valid, notes: null },
    { ...valid, notes: 4 },
    { ...valid, priority: 2 ** 40 },
    { ...valid, priority: "2" },
    { ...valid, status: "closed" },
    { ...valid, status: undefined },
    { ...valid, ratings: [1, "2", NaN, null] },
    { ...valid, ratings: [] },
    { ...valid, ratings: {} },
    { ...valid, ratings: [1, 2, 3, 4] },
    { ...valid, ratings: [1, 2, 3, "4"] },
    { ...valid, matrix: [] },
    { ...valid, matrix: [[1.5], [2, 2 ** 31], "row", [null]] },
    { ...valid, matrix: [1, 2] },
    { ...valid, parent: "none" },
    { ...valid, parent: { id: "x" } },
    { id: "only" },
    { ...valid, __proto__: { polluted: true } },
    JSON.parse(
      '{"id":"a","__proto__":{"x":1},"customer":{"name":"n","email":"e","tier":"gold"},"items":[],"status":"open","ratings":[],"parent":null}',
    ),
  ];
  for (const input of variants) expect(actual.decode(input)).toEqual(order.decode(input));

  // Every property and element is read exactly once, in declaration order, on
  // both decoders, including inside nested objects and arrays.
  for (const good of [true, false]) {
    const runs = [order, actual].map((decoder) => {
      const reads: string[] = [];
      const track = <T extends object>(name: string, target: T): T =>
        new Proxy(target, {
          get(object, key, receiver) {
            // Array lengths are re-read per iteration by the generic loops;
            // property and element reads are the invariant.
            if (typeof key === "string" && key !== "length") reads.push(`${name}.${key}`);
            return Reflect.get(object, key, receiver);
          },
          getPrototypeOf(object) {
            reads.push(`${name}.[[Prototype]]`);
            return Reflect.getPrototypeOf(object);
          },
        });
      const input = track("order", {
        id: "order-1",
        customer: track("customer", { name: "Ada", email: "e", tier: good ? "gold" : "bronze" }),
        items: track("items", [
          track("item0", {
            sku: "S",
            name: "n",
            quantity: good ? 1 : 0,
            unitPrice: 1,
            tags: track("tags", ["a"]),
          }),
        ]),
        status: "open",
        ratings: track("ratings", [1, good ? 2 : "x"]),
        matrix: track("matrix", [track("row0", [1, 2]), track("row1", [])]),
        parent: null,
        ignored: track("ignored", {}),
      });
      return { result: decoder.decode(input), reads };
    });
    expect(runs[1]!.reads).toEqual(runs[0]!.reads);
    expect(runs[1]!.result).toEqual(runs[0]!.result);
  }
});
