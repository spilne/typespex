import { createMcpServer, createSchema } from "@typespex/mcp-server";
import { serveMcpStdio } from "../../src/index.js";

const schema = createSchema<{ value: string }>({
  schema: {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object",
    properties: { value: { type: "string" } },
    required: ["value"],
    additionalProperties: false,
  },
  codec: {
    root: {
      kind: "object",
      properties: { value: { wireName: "value", codec: { kind: "identity" } } },
    },
  },
});

serveMcpStdio(() =>
  createMcpServer(
    { implementation: { name: "stdio-test", version: "1.0.0" } },
    [{ name: "echo", input: schema, success: schema }],
    { handlers: { echo: (input: { value: string }) => input } },
  ),
);
