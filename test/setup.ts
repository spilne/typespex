import { setDefaultTimeout } from "bun:test";

// Compiler-backed tests spawn TypeSpec and TypeScript subprocesses. Configure
// this from a preload so every parallel test worker receives the same limit.
setDefaultTimeout(30_000);
