import type { DiagnosticTarget } from "@typespec/compiler";
import type { ValueCodecDocument } from "@typespex/runtime/codec";

export const CODEGEN_PLAN_VERSION = 1 as const;

export type JsonSchema = boolean | Readonly<Record<string, unknown>>;

export interface ServicePlan {
  readonly version: typeof CODEGEN_PLAN_VERSION;
  readonly name: string;
  readonly namespace: string;
  readonly operations: readonly OperationPlan[];
}

export interface OperationPlan {
  readonly name: string;
  readonly input: JsonWirePlan;
  readonly success?: JsonWirePlan;
  readonly errors?: JsonWirePlan;
}

export interface TypePlan {
  readonly key: string;
  readonly name?: string;
  readonly tsType: string;
  readonly wire: JsonWirePlan;
}

export interface JsonWirePlan {
  readonly schema: JsonSchema;
  readonly codec: ValueCodecDocument;
  readonly semanticType: string;
}

export interface ArtifactPlan {
  readonly artifact: string;
  readonly fileName: string;
  readonly outputDir: string;
  readonly content: string;
}

export interface HttpWireOperationPlan {
  readonly version: typeof CODEGEN_PLAN_VERSION;
  readonly operationId: string;
  readonly method: string;
  readonly path: string;
  readonly literalQuery?: readonly HttpLiteralQueryPlan[];
  readonly parameters: readonly HttpParameterPlan[];
  readonly requestBody?: HttpBodyPlan;
  readonly responses: readonly HttpResponsePlan[];
  readonly servers?: readonly HttpServerPlan[];
  readonly auth?: readonly HttpAuthAlternativePlan[];
}

export interface HttpParameterPlan {
  readonly source: readonly (string | number)[];
  readonly wireName: string;
  readonly location: "path" | "query" | "header" | "cookie";
  readonly required: boolean;
  readonly style?:
    | "simple"
    | "label"
    | "matrix"
    | "path"
    | "form"
    | "spaceDelimited"
    | "pipeDelimited"
    | "deepObject";
  readonly explode?: boolean;
  readonly allowReserved?: boolean;
  readonly value?: HttpWireValuePlan;
}

export interface HttpBodyPlan {
  readonly source?: readonly (string | number)[];
  readonly fields?: readonly HttpBodyFieldPlan[];
  readonly kind: "json" | "form" | "multipart" | "text" | "binary" | "file" | "jsonl";
  readonly contentTypes: readonly string[];
  readonly contentTypeSource?: readonly (string | number)[];
  readonly mediaTypes?: readonly HttpBodyMediaTypePlan[];
  readonly multipartParts?: readonly HttpMultipartPartPlan[];
  readonly value?: HttpWireValuePlan;
}

export interface HttpBodyMediaTypePlan {
  readonly contentType: string;
  readonly kind: HttpBodyPlan["kind"];
  readonly value?: HttpWireValuePlan;
}

export interface HttpMultipartPartPlan {
  readonly source: readonly (string | number)[];
  readonly name?: string;
  readonly multi: boolean;
  readonly optional: boolean;
  readonly kind: Exclude<HttpBodyPlan["kind"], "multipart" | "jsonl" | "form">;
  readonly contentTypes: readonly string[];
  readonly value?: HttpWireValuePlan;
}

export interface HttpLiteralQueryPlan {
  readonly name: string;
  readonly value: string;
}

export interface HttpBodyFieldPlan {
  readonly source: readonly (string | number)[];
  readonly target: readonly (string | number)[];
}

export interface HttpResponsePlan {
  readonly statusCodes: readonly (number | `${number}XX` | "default")[];
  readonly contentTypes: readonly string[];
  readonly kind: "json" | "form" | "multipart" | "text" | "binary" | "file" | "jsonl" | "empty";
  readonly error: boolean;
  readonly bodyValue?: HttpWireValuePlan;
  readonly multipartParts?: readonly HttpResponseMultipartPartPlan[];
  readonly bodyTarget?: readonly (string | number)[];
  readonly statusTarget?: readonly (string | number)[];
  readonly contentTypeTarget?: readonly (string | number)[];
  readonly headers?: readonly HttpResponseHeaderPlan[];
}

export interface HttpResponseMultipartPartPlan {
  readonly target: readonly (string | number)[];
  readonly name?: string;
  readonly multi: boolean;
  readonly optional: boolean;
  readonly kind: "json" | "text" | "binary" | "file";
  readonly contentTypes: readonly string[];
  readonly value?: HttpWireValuePlan;
}

export interface HttpResponseHeaderPlan {
  readonly wireName: string;
  readonly target: readonly (string | number)[];
  readonly collection?: boolean;
  readonly value?: HttpWireValuePlan;
}

export type HttpWireValuePlan =
  | { readonly kind: "identity" }
  | { readonly kind: "string" }
  | { readonly kind: "number"; readonly integer?: boolean }
  | { readonly kind: "boolean" }
  | { readonly kind: "null" }
  | {
      readonly kind: "scalar-encoding";
      readonly encoding:
        | "number-string"
        | "integer-string"
        | "boolean-string"
        | "rfc7231"
        | "unix-timestamp"
        | "duration-seconds"
        | "duration-milliseconds"
        | "base64url";
    }
  | {
      readonly kind: "file-json";
      readonly contentTypeSource?: string;
      readonly filenameSource?: string;
      readonly contentsSource: string;
      readonly textContents: boolean;
    }
  | { readonly kind: "literal"; readonly value: string | number | boolean | null }
  | { readonly kind: "array"; readonly item: HttpWireValuePlan }
  | { readonly kind: "tuple"; readonly items: readonly HttpWireValuePlan[] }
  | {
      readonly kind: "object";
      readonly properties: Readonly<Record<string, HttpWirePropertyPlan>>;
      readonly additional?: HttpWireValuePlan;
    }
  | { readonly kind: "union"; readonly variants: readonly HttpWireValuePlan[] };

export interface HttpWirePropertyPlan {
  readonly sourceName: string;
  readonly value: HttpWireValuePlan;
  readonly optional: boolean;
}

export interface HttpServerPlan {
  readonly url: string;
  readonly fullyDefaulted: boolean;
}

export type HttpAuthSchemePlan =
  | {
      readonly id: string;
      readonly type: "apiKey";
      readonly location: "header" | "query" | "cookie";
      readonly name: string;
    }
  | { readonly id: string; readonly type: "http"; readonly scheme: string }
  | { readonly id: string; readonly type: "oauth2" | "openIdConnect" };

export type HttpAuthAlternativePlan =
  | { readonly noAuth: true }
  | { readonly schemes: readonly HttpAuthSchemePlan[] };

export interface CodegenIssue {
  readonly code:
    | "unsafe-number"
    | "unsupported-encoding"
    | "unsupported-stream"
    | "unsupported-type";
  readonly message: string;
  readonly target: DiagnosticTarget;
}
