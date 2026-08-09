import { createTypeSpecLibrary, paramMessage, type JSONSchemaType } from "@typespec/compiler";

export interface TypespexEmitterOptions {
  "service-output"?: "auto" | "flat" | "prefix" | "directory";
  "service-folder-pattern"?: string;
  "file-name-pattern"?: string;
}

const EmitterOptionsSchema: JSONSchemaType<TypespexEmitterOptions> = {
  type: "object",
  additionalProperties: false,
  properties: {
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
    "duplicate-output-path": {
      severity: "error",
      messages: {
        default: paramMessage`Generated artifacts "${"first"}" and "${"second"}" both resolve to "${"path"}". Give the services unique names or configure layout patterns that resolve to distinct paths.`,
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
        default: paramMessage`Unsupported HTTP response content type "${"contentType"}" for operation "${"operationName"}". Supported types: application/json, structured +json, text/*, application/octet-stream.`,
      },
    },
    "unsupported-response-status-code": {
      severity: "error",
      messages: {
        default: paramMessage`HTTP response status contract for operation "${"operationName"}" is not supported: ${"reason"}.`,
      },
    },
    "unsupported-response-body": {
      severity: "error",
      messages: {
        default: paramMessage`HTTP response body for operation "${"operationName"}" cannot be encoded as "${"contentType"}": ${"reason"}.`,
      },
    },
    "unsupported-json-serialization": {
      severity: "error",
      messages: {
        default: paramMessage`JSON response for operation "${"operation"}" cannot be serialized safely: ${"reason"}.`,
      },
    },
    "ignored-encode": {
      severity: "error",
      messages: {
        default: paramMessage`@encode on "${"name"}" is not supported by @typespex/emitter; operation "${"operation"}" would use the wrong wire format for property "${"property"}".`,
      },
    },
    "ignored-encoded-name": {
      severity: "error",
      messages: {
        default: paramMessage`@encodedName on "${"name"}" is not supported by @typespex/emitter; generating this service would use the wrong property name on the wire.`,
      },
    },
    "ignored-discriminated": {
      severity: "error",
      messages: {
        default: paramMessage`@discriminated union "${"name"}" is not supported by @typespex/emitter; generating this service would use the wrong envelope format.`,
      },
    },
    "ignored-visibility": {
      severity: "error",
      messages: {
        default: paramMessage`Visibility decorators on "${"name"}" are not supported by @typespex/emitter; generating this service would expose the wrong request or response shape.`,
      },
    },
    "ignored-auth": {
      severity: "error",
      messages: {
        default:
          "@useAuth is not supported by @typespex/emitter; generating this service would omit required authentication metadata.",
      },
    },
    "unsupported-http-parameter": {
      severity: "error",
      messages: {
        default: paramMessage`HTTP ${"location"} parameter "${"name"}" is not supported: ${"reason"}.`,
      },
    },
    "unsupported-request-body": {
      severity: "error",
      messages: {
        default: paramMessage`Request body for operation "${"operation"}" cannot be decoded as "${"contentType"}": ${"reason"}.`,
      },
    },
    "request-input-property-collision": {
      severity: "error",
      messages: {
        default: paramMessage`Operation "${"operation"}" has multiple HTTP inputs (${"locations"}) that resolve to handler property "${"property"}". Rename one of the source properties so every wire input has a distinct handler property.`,
      },
    },
    "unsupported-uri-template": {
      severity: "error",
      messages: {
        default: paramMessage`URI template "${"template"}" for operation "${"operation"}" cannot be lowered safely: ${"reason"}.`,
      },
    },
  },
  emitter: {
    options: EmitterOptionsSchema,
  },
} as const);
