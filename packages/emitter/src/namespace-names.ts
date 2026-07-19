import {
  getNamespaceFullName as getTypeSpecNamespaceFullName,
  type Namespace,
} from "@typespec/compiler";

export function getNamespaceFullName(namespace: Namespace | undefined): string {
  return namespace ? getTypeSpecNamespaceFullName(namespace) : "";
}
