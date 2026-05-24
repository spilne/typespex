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
  },
  emitter: {
    options: EmitterOptionsSchema,
  },
} as const);
