import { beforeAll, describe, expect, test } from "bun:test";

describe("toColonPath", () => {
  let toColonPath: (path: string) => string;

  beforeAll(async () => {
    const mod = await import("../dist/emit-server-common.js");
    toColonPath = mod.toColonPath;
  });

  test("converts {param} to :param", () => {
    expect(toColonPath("/pets/{petId}")).toBe("/pets/:petId");
  });

  test("converts multiple params", () => {
    expect(toColonPath("/users/{userId}/posts/{postId}")).toBe("/users/:userId/posts/:postId");
  });

  test("no-op on paths without params", () => {
    expect(toColonPath("/health")).toBe("/health");
  });

  test("handles root path", () => {
    expect(toColonPath("/")).toBe("/");
  });
});
