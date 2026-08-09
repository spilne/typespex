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
});
