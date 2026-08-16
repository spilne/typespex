import { expect, test } from "bun:test";
import { consoleLogger } from "../src/index.js";

test("consoleLogger forwards plain and structured messages at every level", () => {
  const calls = {
    error: [] as unknown[][],
    warn: [] as unknown[][],
    info: [] as unknown[][],
  };
  const original = {
    error: console.error,
    warn: console.warn,
    info: console.info,
  };

  try {
    console.error = (...args: unknown[]) => calls.error.push(args);
    console.warn = (...args: unknown[]) => calls.warn.push(args);
    console.info = (...args: unknown[]) => calls.info.push(args);

    const context = { requestId: "req-1" };
    consoleLogger.error("plain error");
    consoleLogger.error("structured error", context);
    consoleLogger.warn("plain warning");
    consoleLogger.warn("structured warning", context);
    consoleLogger.info("plain info");
    consoleLogger.info("structured info", context);

    expect(calls).toEqual({
      error: [["plain error"], ["structured error", context]],
      warn: [["plain warning"], ["structured warning", context]],
      info: [["plain info"], ["structured info", context]],
    });
  } finally {
    console.error = original.error;
    console.warn = original.warn;
    console.info = original.info;
  }
});
