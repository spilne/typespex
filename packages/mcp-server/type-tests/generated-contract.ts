import {
  createMcpServer,
  createSchema,
  mcpError,
  mcpSuccess,
  type McpToolDefinition,
  type McpApplication,
  type McpHandlersFor,
  type McpToolContext,
  // @ts-expect-error bridge wire markers are intentionally absent from the public root
  mcpWireSuccess,
} from "../src/index.js";

void mcpWireSuccess;

const input = createSchema<{ wire_id: string }, { id: string }>({
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
const success = createSchema<{ wire_name: string }, { name: string }>({ schema: true });
const error = createSchema<{ code: "missing" }, { code: "missing" }>({ schema: true });

const tools = [
  { name: "read", input, success, errors: error },
] as const satisfies readonly McpToolDefinition[];
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

interface ApplicationContext extends McpToolContext {
  readonly prefix: string;
}

type ContextualHandlers = McpHandlersFor<typeof tools, ApplicationContext>;
const contextual: McpApplication<ContextualHandlers, ApplicationContext> = {
  createContext: (context) => ({ ...context, prefix: "pet:" }),
  handlers: {
    read: ({ id }, context) => ({ name: `${context.prefix}${id}` }),
  },
};
const contextualServer = createMcpServer(
  { implementation: { name: "contextual", version: "1.0.0" } },
  tools,
  contextual,
);
void contextualServer;

// @ts-expect-error native applications cannot omit the generated handler map
const invalidNative: McpApplication<Handlers> = { kind: "native" };
void invalidNative;

const taggedTools = [
  {
    name: "ambiguous",
    input,
    success,
    errors: error,
    requiresTaggedResult: true,
  },
] as const satisfies readonly McpToolDefinition[];
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
