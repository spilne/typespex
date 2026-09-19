import { describe, expect, test } from "bun:test";
import { stringifyJson } from "../src/http/json.js";

describe("JSON response serialization", () => {
  test("reads getters and serialization hooks once even when a later value needs bigint fallback", () => {
    for (const tail of [1, 9_223_372_036_854_775_807n]) {
      const events: string[] = [];
      const value = {
        get first() {
          events.push("get first");
          return {
            toJSON(key: string) {
              events.push(`toJSON ${key}`);
              return { nested: new Uint8Array([1, 2, 255]) };
            },
          };
        },
        tail,
      };

      expect(stringifyJson(value)).toBe(`{"first":{"nested":"AQL/"},"tail":${String(tail)}}`);
      expect(events).toEqual(["get first", "toJSON first"]);
    }
  });

  test("preserves recursive hook keys and skips hooks on functions and bytes", () => {
    const keys: string[] = [];
    const ignoredFunction = Object.assign(() => {}, {
      toJSON() {
        throw new Error("Functions are omitted before reading toJSON.");
      },
    });
    const bytes = Object.assign(new Uint8Array([255]), {
      toJSON() {
        throw new Error("Bytes are encoded before reading toJSON.");
      },
    });
    const value = {
      toJSON(key: string) {
        keys.push(key);
        return [
          {
            toJSON(key: string) {
              keys.push(key);
              return {
                toJSON(key: string) {
                  keys.push(key);
                  return { kept: true, ignoredFunction, bytes };
                },
              };
            },
          },
        ];
      },
    };

    expect(stringifyJson(value)).toBe('[{"kept":true,"bytes":"/w=="}]');
    expect(keys).toEqual(["", "0", "0"]);
    expect(() => stringifyJson(ignoredFunction)).toThrow("Value is not JSON serializable.");
  });

  test("does not call a prototype hook installed after the original value was visited", () => {
    for (const prototype of [Object.prototype, Array.prototype]) {
      const previous = Object.getOwnPropertyDescriptor(prototype, "toJSON");
      let calls = 0;
      const value = [
        {
          get value() {
            Object.defineProperty(prototype, "toJSON", {
              configurable: true,
              value() {
                calls++;
                throw new Error("An already visited value must not be serialized again.");
              },
            });
            return "kept";
          },
        },
      ];
      let serialized: string;
      try {
        serialized = stringifyJson(value);
      } finally {
        if (previous) Object.defineProperty(prototype, "toJSON", previous);
        else Reflect.deleteProperty(prototype, "toJSON");
      }
      expect(serialized!).toBe('[{"value":"kept"}]');
      expect(calls).toBe(0);
    }
  });

  test("does not assign through inherited setters while preparing object properties", () => {
    const property = "__typespex_json_value__";
    const previous = Object.getOwnPropertyDescriptor(Object.prototype, property);
    let writes = 0;
    let serialized: string;
    try {
      Object.defineProperty(Object.prototype, property, {
        configurable: true,
        set() {
          writes++;
          throw new Error("Serialization must not invoke a setter.");
        },
      });
      const value = Object.create(null);
      value[property] = "kept";
      value.__proto__ = { data: true };
      serialized = stringifyJson(value);
    } finally {
      if (previous) Object.defineProperty(Object.prototype, property, previous);
      else Reflect.deleteProperty(Object.prototype, property);
    }
    expect(serialized!).toBe('{"__typespex_json_value__":"kept","__proto__":{"data":true}}');
    expect(writes).toBe(0);
  });

  test("preserves array growth and sparse entries observed during serialization", () => {
    const value: unknown[] = [];
    Object.defineProperty(value, 0, {
      get() {
        value[2] = "added";
        return "first";
      },
    });
    expect(stringifyJson(value)).toBe('["first",null,"added"]');
  });

  test("preserves custom enumeration order for integer properties", () => {
    const value = new Proxy(
      { 1: "first", 2: "second", name: "kept" },
      {
        ownKeys: () => ["name", "2", "1"],
      },
    );
    expect(stringifyJson({ value })).toBe('{"value":{"name":"kept","2":"second","1":"first"}}');
  });
});
