import { describe, expect, test } from "bun:test";
import { defineDataProperty } from "../src/http/object-properties.js";

describe("decoded object properties", () => {
  test("creates mutable own data properties on ordinary and null-prototype objects", () => {
    for (const target of [{}, Object.create(null)]) {
      defineDataProperty(target, "name", "Pet");
      expect(Object.getOwnPropertyDescriptor(target, "name")).toEqual({
        value: "Pet",
        writable: true,
        enumerable: true,
        configurable: true,
      });
    }
  });

  test("shadows inherited setters and read-only properties without invoking them", () => {
    let setterCalls = 0;
    const prototype = Object.defineProperties(
      {},
      {
        name: { set: () => setterCalls++ },
        id: { value: "inherited", writable: false },
      },
    );
    const target = Object.create(prototype);
    defineDataProperty(target, "name", "Pet");
    defineDataProperty(target, "id", "own");
    defineDataProperty(target, "__proto__", "data");
    expect(setterCalls).toBe(0);
    expect(Object.getPrototypeOf(target)).toBe(prototype);
    expect(Object.keys(target)).toEqual(["name", "id", "__proto__"]);
    expect(target).toEqual({ name: "Pet", id: "own", ["__proto__"]: "data" });
  });

  test("replaces configurable own accessors without calling their setter", () => {
    let setterCalls = 0;
    const target = Object.defineProperty({}, "name", {
      set: () => setterCalls++,
      configurable: true,
    });
    defineDataProperty(target, "name", "Pet");
    expect(setterCalls).toBe(0);
    expect(Object.getOwnPropertyDescriptor(target, "name")).toEqual({
      value: "Pet",
      writable: true,
      enumerable: true,
      configurable: true,
    });
  });
});
