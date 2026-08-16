import { describe, expect, test } from "bun:test";
import { isContentTypeAccepted, parseMediaType } from "../src/server.js";

describe("parseMediaType", () => {
  test("returns undefined for missing or empty input", () => {
    expect(parseMediaType(null)).toBeUndefined();
    expect(parseMediaType(undefined)).toBeUndefined();
    expect(parseMediaType("")).toBeUndefined();
    expect(parseMediaType("   ")).toBeUndefined();
    expect(parseMediaType(";")).toBeUndefined();
  });

  test("strips parameters and lowercases the media type", () => {
    expect(parseMediaType("Application/JSON")).toBe("application/json");
    expect(parseMediaType("application/json; charset=utf-8")).toBe("application/json");
    expect(parseMediaType("multipart/form-data; boundary=---x")).toBe("multipart/form-data");
    expect(parseMediaType(" text/plain ")).toBe("text/plain");
  });

  test("rejects malformed type/subtype values", () => {
    for (const value of ["garbage", "text/", "/plain", "text/plain/extra", "text/pla in"]) {
      expect(parseMediaType(value)).toBeUndefined();
    }
  });
});

describe("isContentTypeAccepted", () => {
  test("accepts anything when no declared types are provided", () => {
    expect(isContentTypeAccepted(null, [])).toBe(true);
    expect(isContentTypeAccepted("application/json", [])).toBe(true);
  });

  test("rejects missing Content-Type when declared types are required", () => {
    expect(isContentTypeAccepted(null, ["application/json"])).toBe(false);
    expect(isContentTypeAccepted(undefined, ["application/json"])).toBe(false);
    expect(isContentTypeAccepted("", ["application/json"])).toBe(false);
  });

  test("matches exact media type ignoring case and parameters", () => {
    expect(isContentTypeAccepted("application/json", ["application/json"])).toBe(true);
    expect(isContentTypeAccepted("Application/JSON; charset=utf-8", ["application/json"])).toBe(
      true,
    );
    expect(
      isContentTypeAccepted("multipart/form-data; boundary=abc", ["multipart/form-data"]),
    ).toBe(true);
  });

  test("supports subtype wildcards like image/* and */*", () => {
    expect(isContentTypeAccepted("image/png", ["image/*"])).toBe(true);
    expect(isContentTypeAccepted("image/jpeg", ["image/*"])).toBe(true);
    expect(isContentTypeAccepted("text/html", ["image/*"])).toBe(false);
    expect(isContentTypeAccepted("application/octet-stream", ["*/*"])).toBe(true);
  });

  test("wildcard contracts still require a concrete valid received media type", () => {
    for (const value of ["garbage", "text/", "/plain", "text/plain/extra", "*/*", "image/*"]) {
      expect(isContentTypeAccepted(value, ["*/*"])).toBe(false);
    }
  });

  test("matches when any declared entry matches", () => {
    expect(isContentTypeAccepted("text/plain", ["application/json", "text/plain"])).toBe(true);
    expect(isContentTypeAccepted("application/xml", ["application/json", "text/plain"])).toBe(
      false,
    );
  });
});
