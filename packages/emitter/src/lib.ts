import { createTypeSpecLibrary, type JSONSchemaType } from "@typespec/compiler";

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
  },
  emitter: {
    options: EmitterOptionsSchema,
  },
} as const);
