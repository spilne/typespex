import { createTypeSpecLibrary, paramMessage, type JSONSchemaType } from "@typespec/compiler";

export interface TypespexEmitterOptions {
  "output-dir"?: string;
  "service-output"?: "auto" | "flat" | "prefix" | "directory";
  "service-folder-pattern"?: string;
  "file-name-pattern"?: string;
}

const EmitterOptionsSchema: JSONSchemaType<TypespexEmitterOptions> = {
  type: "object",
  additionalProperties: false,
  properties: {
    "output-dir": { type: "string", nullable: true },
    "service-output": {
      type: "string",
      enum: ["auto", "flat", "prefix", "directory"],
      nullable: true,
    },
    "service-folder-pattern": { type: "string", nullable: true },
    "file-name-pattern": { type: "string", nullable: true },
  },
  required: [],
};

export const $lib = createTypeSpecLibrary({
  name: "@typespex/emitter",
  diagnostics: {
    "unsupported-type": {
      severity: "warning",
      messages: {
        default: "Unsupported type encountered, emitting 'unknown'",
      },
    },
    "no-services": {
      severity: "warning",
      messages: {
        default: "No HTTP services found in program",
      },
    },
    "undifferentiable-response-union": {
      severity: "error",
      messages: {
        default: "HTTP response union variants cannot be safely differentiated.",
      },
    },
    "unsupported-response-content-type": {
      severity: "error",
      messages: {
        default: paramMessage`Unsupported HTTP response content type "${"contentType"}" for operation "${"operationName"}". Supported types: application/json, text/*, application/octet-stream.`,
      },
    },
    "ignored-encode": {
      severity: "error",
      messages: {
        default: paramMessage`@encode on "${"name"}" is not supported by @typespex/emitter — the generated server would use the wrong wire format.`,
      },
    },
    "ignored-encoded-name": {
      severity: "error",
      messages: {
        default: paramMessage`@encodedName on "${"name"}" is not supported by @typespex/emitter — generated decoders and encoders would use the TypeScript property name on the wire.`,
      },
    },
    "ignored-discriminated": {
      severity: "error",
      messages: {
        default: paramMessage`@discriminated union "${"name"}" is not supported by @typespex/emitter — the envelope wire format would not be applied.`,
      },
    },
    "ignored-visibility": {
      severity: "warning",
      messages: {
        default: paramMessage`Visibility decorators on "${"name"}" are ignored by @typespex/emitter — generated request and response shapes include all properties.`,
      },
    },
    "ignored-auth": {
      severity: "warning",
      messages: {
        default: "@useAuth is ignored by @typespex/emitter — authentication metadata is not surfaced and no auth is enforced.",
      },
    },
  },
  emitter: {
    options: EmitterOptionsSchema,
  },
} as const);
