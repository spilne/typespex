import { describe, expect, test } from "bun:test";
import { JsonSerializationError, JsonSerializers, type JsonSerializer } from "../src/server.js";

interface Profile {
  displayName: string;
}

interface User {
  userId: string;
  profile: Profile;
  aliases: Profile[];
  directory: Record<string, Profile>;
  optionalProfile?: Profile;
  nullableProfile: Profile | null;
}

const profile = JsonSerializers.object<Profile>([
  {
    property: "displayName",
    wireName: "display_name",
    serializer: JsonSerializers.identity(),
  },
]);

const user = JsonSerializers.object<User>([
  { property: "userId", wireName: "user_id", serializer: JsonSerializers.identity() },
  { property: "profile", wireName: "profile", serializer: profile },
  { property: "aliases", wireName: "aliases", serializer: JsonSerializers.array(profile) },
  {
    property: "directory",
    wireName: "directory",
    serializer: JsonSerializers.record(profile),
  },
  {
    property: "optionalProfile",
    wireName: "optional_profile",
    serializer: profile,
    optional: true,
  },
  {
    property: "nullableProfile",
    wireName: "nullable_profile",
    serializer: JsonSerializers.nullable(profile),
  },
]);

describe("JsonSerializers", () => {
  test("renames and recursively serializes modeled JSON properties", () => {
    expect(
      user.serialize({
        userId: "u-1",
        profile: { displayName: "Primary" },
        aliases: [{ displayName: "Alias" }],
        directory: { admin: { displayName: "Administrator" } },
        nullableProfile: null,
      }),
    ).toEqual({
      user_id: "u-1",
      profile: { display_name: "Primary" },
      aliases: [{ display_name: "Alias" }],
      directory: { admin: { display_name: "Administrator" } },
      nullable_profile: null,
    });
  });

  test("preserves modeled additional properties without prototype mutation", () => {
    const serializer = JsonSerializers.object<Profile & Record<string, string>>(
      [
        {
          property: "displayName",
          wireName: "display_name",
          serializer: JsonSerializers.identity(),
        },
      ],
      { additionalProperties: JsonSerializers.identity() },
    );
    const value = Object.create(null) as Profile & Record<string, string>;
    value.displayName = "Safe";
    value.__proto__ = "data";

    const serialized = serializer.serialize(value) as Record<string, unknown>;
    expect(serialized.display_name).toBe("Safe");
    expect(Object.prototype.hasOwnProperty.call(serialized, "__proto__")).toBe(true);
    expect(serialized.__proto__).toBe("data");
    expect(Object.getPrototypeOf(serialized)).toBeNull();
  });

  test("serializes modeled own properties from class instances", () => {
    class ProfileValue implements Profile {
      constructor(readonly displayName: string) {}
    }

    expect(profile.serialize(new ProfileValue("Class profile"))).toEqual({
      display_name: "Class profile",
    });
  });

  test("reports the handler property path for malformed nested values", () => {
    expect(() =>
      user.serialize({
        userId: "u-1",
        profile: null,
        aliases: [],
        directory: {},
        nullableProfile: null,
      } as unknown as User),
    ).toThrow(JsonSerializationError);

    try {
      user.serialize({
        userId: "u-1",
        profile: null,
        aliases: [],
        directory: {},
        nullableProfile: null,
      } as unknown as User);
    } catch (error) {
      expect(error).toBeInstanceOf(JsonSerializationError);
      expect((error as JsonSerializationError).path).toBe("$response.profile");
      expect((error as Error).message).toContain("Expected an object");
    }
  });

  test("tries exact union shapes and rejects conflicting wire representations", () => {
    type TextValue = { kind: "same"; start: string };
    type DateValue = { kind: "same"; start: string; end?: string };
    type Value = TextValue | DateValue;

    const text = JsonSerializers.exactObject(
      JsonSerializers.object<TextValue>([
        { property: "kind", wireName: "kind", serializer: JsonSerializers.literal("same") },
        { property: "start", wireName: "start", serializer: JsonSerializers.identity() },
      ]),
      ["kind", "start"],
    );
    const dated = JsonSerializers.exactObject(
      JsonSerializers.object<DateValue>([
        { property: "kind", wireName: "kind", serializer: JsonSerializers.literal("same") },
        { property: "start", wireName: "start", serializer: JsonSerializers.rfc3339DateTime },
        {
          property: "end",
          wireName: "end",
          serializer: JsonSerializers.rfc3339DateTime,
          optional: true,
        },
      ]),
      ["kind", "start", "end"],
    );
    const values = JsonSerializers.union<Value>([text, dated]);

    expect(values.serialize({ kind: "same", start: "plain text" })).toEqual({
      kind: "same",
      start: "plain text",
    });
    expect(
      values.serialize({
        kind: "same",
        start: "2021-01-01T00:00:00Z",
        end: "2021-01-02T00:00:00Z",
      }),
    ).toEqual({
      kind: "same",
      start: "2021-01-01T00:00:00Z",
      end: "2021-01-02T00:00:00Z",
    });
    expect(() => values.serialize({ kind: "same", start: "invalid", end: "invalid" })).toThrow(
      "Value did not match any union variant",
    );

    type Left = { value: string };
    type Right = { value: string };
    const ambiguous = JsonSerializers.union<Left | Right>([
      JsonSerializers.exactObject(
        JsonSerializers.object<Left>([
          { property: "value", wireName: "left_value", serializer: JsonSerializers.identity() },
        ]),
        ["value"],
      ),
      JsonSerializers.exactObject(
        JsonSerializers.object<Right>([
          { property: "value", wireName: "right_value", serializer: JsonSerializers.identity() },
        ]),
        ["value"],
      ),
    ]);
    expect(() => ambiguous.serialize({ value: "conflict" })).toThrow(
      "multiple union variants with different JSON wire representations",
    );
  });

  test("supports recursive serializers lazily", () => {
    interface Node {
      name: string;
      child?: Node;
    }

    let node!: JsonSerializer<Node>;
    node = JsonSerializers.lazy(() =>
      JsonSerializers.object<Node>([
        { property: "name", wireName: "node_name", serializer: JsonSerializers.identity() },
        { property: "child", wireName: "child", serializer: node, optional: true },
      ]),
    );

    expect(node.serialize({ name: "root", child: { name: "leaf" } })).toEqual({
      node_name: "root",
      child: { node_name: "leaf" },
    });
  });

  test("dispatches discriminated serializers and reports the discriminator path", () => {
    type Animal = { kind: "cat"; displayName: string } | { kind: "dog"; bark: boolean };
    const animals = JsonSerializers.discriminated<Animal>("kind", {
      cat: JsonSerializers.object<{ kind: "cat"; displayName: string }>([
        { property: "kind", wireName: "kind", serializer: JsonSerializers.identity() },
        {
          property: "displayName",
          wireName: "display_name",
          serializer: JsonSerializers.identity(),
        },
      ]),
      dog: JsonSerializers.object<{ kind: "dog"; bark: boolean }>([
        { property: "kind", wireName: "kind", serializer: JsonSerializers.identity() },
        { property: "bark", wireName: "bark", serializer: JsonSerializers.identity() },
      ]),
    });

    expect(animals.serialize({ kind: "cat", displayName: "Miso" })).toEqual({
      kind: "cat",
      display_name: "Miso",
    });
    expect(() => animals.serialize({ kind: "bird" } as unknown as Animal)).toThrow(
      "$response.kind: Unknown discriminator value",
    );
    expect(() => animals.serialize({ displayName: "Missing" } as unknown as Animal)).toThrow(
      "$response.kind: Unknown discriminator value",
    );
  });

  test("supports default and prototype-sensitive discriminator variants", () => {
    type Value = { kind: "__proto__"; value: string } | { kind: string; value: { raw: string } };
    const serializer = JsonSerializers.discriminated<Value>(
      "kind",
      {
        ["__proto__"]: JsonSerializers.object<{ kind: "__proto__"; value: string }>([
          { property: "kind", wireName: "kind", serializer: JsonSerializers.identity() },
          { property: "value", wireName: "value", serializer: JsonSerializers.identity() },
        ]),
      },
      {
        defaultVariant: JsonSerializers.object<{ kind: string; value: { raw: string } }>([
          { property: "kind", wireName: "kind", serializer: JsonSerializers.identity() },
          {
            property: "value",
            wireName: "value",
            serializer: JsonSerializers.object([
              { property: "raw", wireName: "raw_value", serializer: JsonSerializers.identity() },
            ]),
          },
        ]),
      },
    );

    expect(serializer.serialize({ kind: "__proto__", value: "safe" })).toEqual({
      kind: "__proto__",
      value: "safe",
    });
    expect(serializer.serialize({ kind: "future", value: { raw: "opaque" } })).toEqual({
      kind: "future",
      value: { raw_value: "opaque" },
    });
  });
});
