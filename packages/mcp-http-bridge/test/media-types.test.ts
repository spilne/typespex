import { describe, expect, test } from "bun:test";
import { defaultContentType, mediaTypeMatches } from "../src/media-types.js";

describe("HTTP bridge media types", () => {
  test("matches exact, wildcard, and structured-suffix media ranges", () => {
    expect(mediaTypeMatches(undefined, "*/*")).toBe(false);
    expect(mediaTypeMatches("application/json", "*/*")).toBe(true);
    expect(mediaTypeMatches("text/plain", "text/*")).toBe(true);
    expect(mediaTypeMatches("application/problem+json", "application/*+json")).toBe(true);
    expect(mediaTypeMatches("image/png", "text/*")).toBe(false);
  });

  test("provides defaults for every supported request body kind", () => {
    expect({
      json: defaultContentType("json"),
      form: defaultContentType("form"),
      multipart: defaultContentType("multipart"),
      text: defaultContentType("text"),
      jsonl: defaultContentType("jsonl"),
      binary: defaultContentType("binary"),
      file: defaultContentType("file"),
    }).toEqual({
      json: "application/json",
      form: "application/x-www-form-urlencoded",
      multipart: "multipart/form-data",
      text: "text/plain; charset=utf-8",
      jsonl: "application/jsonl",
      binary: "application/octet-stream",
      file: "application/octet-stream",
    });
  });
});
