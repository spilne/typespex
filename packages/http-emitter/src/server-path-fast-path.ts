import type { HttpOperationParameter } from "@typespec/http";
import type { EmitterCtx } from "./ctx.js";
import { getIntrinsicScalarName } from "./scalar-map.js";
import { emitStrictScalarGuard } from "./server-scalar-fast-path.js";
import { tsLiteral, tsObjectKey } from "./typescript-names.js";

/** Avoid intermediate decoder results for a transport-decoded string capture. */
export function emitNativePathDecoder(
  ctx: EmitterCtx,
  parameters: readonly HttpOperationParameter[],
  inputType: string,
  decoderRef: string,
): string {
  const fallback = `decodePathInput<${inputType}>(${decoderRef}.decode, pathParams, true)`;
  if (parameters.length !== 1) return fallback;
  const { name, param } = parameters[0]!;
  if (param.type.kind !== "Scalar" || getIntrinsicScalarName(param.type) !== "string") {
    return fallback;
  }
  const declarations: string[] = [];
  const guard = emitStrictScalarGuard(ctx, param, "value", declarations);
  // A pattern check is observable through RegExp.prototype.test. Leave it in
  // the original decoder rather than evaluating it again on fallback.
  if (!guard || declarations.length) return fallback;
  const condition = param.optional ? `value === undefined || (${guard})` : guard;
  return `{
    const value: string | undefined = pathParams[${tsLiteral(name)}];
    return ${condition}
      ? Either.right<${inputType}>({ ${tsObjectKey(param.name)}: value })
      : decodePathInput<${inputType}>(${decoderRef}.decode, { ${tsObjectKey(name)}: value! }, true);
  }`;
}
