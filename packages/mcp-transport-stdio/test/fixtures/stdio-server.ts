import { createGeneratedMcpServer, createTypeSpecSchema } from "@typespex/mcp-server";
import { serveTypespexStdio } from "../../src/index.js";

const schema = createTypeSpecSchema<{ value: string }>({
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

serveTypespexStdio(() =>
  createGeneratedMcpServer(
    { implementation: { name: "stdio-test", version: "1.0.0" } },
    [{ name: "echo", handler: "echo", input: schema, success: schema }],
    { handlers: { echo: (input: { value: string }) => input } },
  ),
);
