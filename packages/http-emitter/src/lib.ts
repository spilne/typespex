import { createTypeSpecLibrary, paramMessage, type JSONSchemaType } from "@typespec/compiler";

export interface TypespexEmitterOptions {
  "service-output"?: "auto" | "flat" | "prefix" | "directory";
  "service-folder-pattern"?: string;
  "file-name-pattern"?: string;
  "omit-unreachable-types"?: boolean;
  "datetime-mode"?: "string" | "date" | "temporal";
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
    "omit-unreachable-types": { type: "boolean", nullable: true },
    "datetime-mode": {
      type: "string",
      enum: ["string", "date", "temporal"],
      nullable: true,
    },
  },
  required: [],
};

export const $lib = createTypeSpecLibrary({
  name: "@typespex/http-emitter",
  diagnostics: {
    "unsupported-type": {
      severity: "warning",
      messages: {
        default: "Unsupported type encountered, emitting 'unknown'",
      },
    },
    "unsupported-numeric-literal": {
      severity: "error",
      messages: {
        default: paramMessage`Numeric literal "${"value"}" cannot be represented safely by @typespex/http-emitter: ${"reason"}.`,
      },
    },
    "unsupported-string-template": {
      severity: "error",
      messages: {
        default:
          "String template cannot be represented exactly because it does not resolve to one string. Use a concrete template, a string scalar, or an explicit union of string literals.",
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
    "generated-format-error": {
      severity: "error",
      messages: {
        default: paramMessage`Generated TypeScript file "${"file"}" could not be formatted, so no generated files were written. Formatter error: ${"reason"}`,
      },
    },
    "duplicate-route": {
      severity: "error",
      messages: {
        default: paramMessage`Operations "${"first"}" and "${"second"}" both resolve to "${"method"} ${"path"}". Every colliding operation must use @sharedRoute and declare request headers that distinguish it from every other operation.`,
      },
    },
    "ambiguous-shared-route": {
      severity: "error",
      messages: {
        default: paramMessage`Shared operations "${"first"}" and "${"second"}" both resolve to "${"method"} ${"path"}" but their required literal request headers or content types overlap or are absent. Dispatch would be ambiguous.`,
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
        default: paramMessage`Unsupported HTTP response content type "${"contentType"}" for operation "${"operationName"}". Supported types: application/json, structured +json, concrete text media types, application/octet-stream, or any concrete media type with a bytes body.`,
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
    "unsupported-response-header": {
      severity: "error",
      messages: {
        default: paramMessage`HTTP response header "${"header"}" for operation "${"operation"}" cannot be serialized safely: ${"reason"}.`,
      },
    },
    "unsupported-scalar-encoding": {
      severity: "error",
      messages: {
        default: paramMessage`Scalar encoding "${"encoding"}" on "${"name"}" is not supported by @typespex/http-emitter: ${"reason"}.`,
      },
    },
    "ignored-encoded-name": {
      severity: "error",
      messages: {
        default: paramMessage`@encodedName on "${"name"}" is not supported by @typespex/http-emitter; generating this service would use the wrong property name on the wire.`,
      },
    },
    "unsupported-discriminated-union": {
      severity: "error",
      messages: {
        default: paramMessage`@discriminated union "${"name"}" cannot be represented safely: ${"reason"}.`,
      },
    },
    "unsupported-visibility-filter": {
      severity: "error",
      messages: {
        default: paramMessage`Return visibility for operation "${"operation"}" uses all/none constraints that @typespex/http-emitter cannot represent safely.`,
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
