import { isOverloadSameEndpoint, type HttpOperation } from "@typespec/http";

/**
 * Whether an HTTP operation is an alternate signature for the same endpoint
 * as its overload base.
 */
export function isSameEndpointOverload(
  operation: HttpOperation,
): operation is HttpOperation & { overloading: HttpOperation } {
  return (
    operation.overloading !== undefined &&
    isOverloadSameEndpoint(operation as HttpOperation & { overloading: HttpOperation })
  );
}

/**
 * Returns the logical server endpoints represented by a TypeSpec HTTP service.
 *
 * TypeSpec includes same-endpoint overload signatures in `HttpService.operations`,
 * but those signatures do not represent additional runtime endpoints. The base
 * operation is the union contract implemented by the server. Overloads that
 * change their route or verb are distinct endpoints and remain in the surface.
 */
export function getServerHttpOperations(operations: readonly HttpOperation[]): HttpOperation[] {
  return operations.filter((operation) => !isSameEndpointOverload(operation));
}

/** Alternate signatures that refine this operation without adding endpoints. */
export function getSameEndpointOverloads(operation: HttpOperation): HttpOperation[] {
  return (operation.overloads ?? []).filter(isSameEndpointOverload);
}
