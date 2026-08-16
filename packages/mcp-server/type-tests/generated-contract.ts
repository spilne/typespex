import {
  createTypeSpecSchema,
  mcpError,
  mcpSuccess,
  type GeneratedMcpTool,
  type McpApplication,
  type McpHandlersFor,
} from "../src/index.js";

const input = createTypeSpecSchema<{ wire_id: string }, { id: string }>({
  schema: true,
  codec: {
    root: {
      kind: "object",
      properties: {
        id: { wireName: "wire_id", codec: { kind: "primitive", type: "string" } },
      },
    },
  },
});
const success = createTypeSpecSchema<{ wire_name: string }, { name: string }>({ schema: true });
const error = createTypeSpecSchema<{ code: "missing" }, { code: "missing" }>({ schema: true });

const tools = [
  { name: "read", handler: "read", input, success, errors: error },
] as const satisfies readonly GeneratedMcpTool[];
type Handlers = McpHandlersFor<typeof tools>;
type ReadInput = Parameters<Handlers["read"]>[0];

const semanticInput: ReadInput = { id: "pet-1" };
void semanticInput;
// @ts-expect-error handlers receive semantic property names, not wire names
const wireInput: ReadInput = { wire_id: "pet-1" };
void wireInput;

const handlers: Handlers = {
  read: async ({ id }) => (id ? { name: id } : { code: "missing" }),
};
void handlers;

// @ts-expect-error every generated handler is required in native mode
const missingHandler: Handlers = {};
void missingHandler;

const native: McpApplication<Handlers> = { kind: "native", handlers };
void native;

// @ts-expect-error native applications cannot omit the generated handler map
const invalidNative: McpApplication<Handlers> = { kind: "native" };
void invalidNative;

const taggedTools = [
  {
    name: "ambiguous",
    handler: "ambiguous",
    input,
    success,
    errors: error,
    requiresTaggedResult: true,
  },
] as const satisfies readonly GeneratedMcpTool[];
type TaggedHandlers = McpHandlersFor<typeof taggedTools>;

const taggedSuccess: TaggedHandlers = {
  ambiguous: () => mcpSuccess({ name: "ok" }),
};
const taggedError: TaggedHandlers = {
  ambiguous: () => mcpError({ code: "missing" }),
};
void taggedSuccess;
void taggedError;

const invalidTagged: TaggedHandlers = {
  // @ts-expect-error overlapping contracts require an explicit tagged result
  ambiguous: () => ({ name: "not-tagged" }),
};
void invalidTagged;

success.encode({ name: "semantic" });
// @ts-expect-error encoders accept semantic values, not wire values
success.encode({ wire_name: "wire" });
