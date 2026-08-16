import type { DiagnosticTarget } from "@typespec/compiler";
import type { ValueCodecDocument } from "@typespex/runtime/codec";
import type {
  HttpAuthAlternativePlan,
  HttpAuthSchemePlan,
  HttpWirePropertyPlan,
  HttpWireValuePlan,
} from "@typespex/runtime/http-client";
export type {
  HttpAuthAlternativePlan,
  HttpAuthSchemePlan,
  HttpWirePropertyPlan,
  HttpWireValuePlan,
} from "@typespex/runtime/http-client";

export const CODEGEN_PLAN_VERSION = 1 as const;

export type JsonSchema = boolean | Readonly<Record<string, unknown>>;

export interface ServicePlan {
  readonly version: typeof CODEGEN_PLAN_VERSION;
  readonly name: string;
  readonly namespace: string;
  readonly types: readonly TypePlan[];
  readonly operations: readonly OperationPlan[];
}

export interface OperationPlan {
  readonly version: typeof CODEGEN_PLAN_VERSION;
  readonly name: string;
  readonly input: JsonWirePlan;
  readonly success?: JsonWirePlan;
  readonly errors?: JsonWirePlan;
}

export interface TypePlan {
  readonly version: typeof CODEGEN_PLAN_VERSION;
  readonly key: string;
  readonly name?: string;
  readonly semanticType: string;
  readonly wireType: string;
}

export interface JsonWirePlan {
  readonly version: typeof CODEGEN_PLAN_VERSION;
  readonly schema: JsonSchema;
  /** Omitted when the validated JSON value is already the semantic value. */
  readonly codec?: ValueCodecDocument;
  readonly semanticType: string;
  readonly wireType: string;
}

export interface ArtifactPlan {
  readonly version: typeof CODEGEN_PLAN_VERSION;
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

export interface HttpServerPlan {
  readonly url: string;
  readonly fullyDefaulted: boolean;
}

export interface CodegenIssue {
  readonly code:
    | "unsafe-number"
    | "unsupported-encoding"
    | "unsupported-stream"
    | "unsupported-type";
  readonly message: string;
  readonly target: DiagnosticTarget;
}
