import type {
  Enum,
  Model,
  Namespace,
  Program,
  Scalar,
  Type,
  Union,
  Value,
} from "@typespec/compiler";
import { isArrayModelType, isType, isValue } from "@typespec/compiler";
import type { HttpService } from "@typespec/http";
import { getHttpPartType, isHttpFileModel, isHttpPartModel } from "./http-models.js";
import { getAdditionalPropertiesValues, isPureRecordModel } from "./model-indexer.js";
import { getNamespaceFullName } from "./namespace-names.js";
import { isEntityLike } from "./type-guards.js";

export type EmittedNamedType = Model | Scalar | Enum | Union;

/**
 * Collect declarations emitted for a service plus named dependencies reachable
 * from those declarations and the service's HTTP surface.
 */
export function collectEmittedNamedTypes(
  program: Program,
  service: HttpService,
): readonly EmittedNamedType[] {
  const declarations: EmittedNamedType[] = [];
  const included = new Set<string>();
  const expanded = new Set<string>();

  collectNamespaceDeclarations(program, service.namespace, (type) => {
    addDeclaration(type);
  });

  for (const declaration of [...declarations]) {
    expandDeclaration(declaration);
  }

  for (const operation of service.operations) {
    for (const parameter of operation.parameters.parameters) {
      visitType(parameter.param.type);
    }
    if (operation.parameters.body) visitType(operation.parameters.body.type);
    visitType(operation.operation.returnType);
    for (const response of operation.responses) {
      visitType(response.type);
      for (const content of response.responses) {
        if (content.body) visitType(content.body.type);
      }
    }
  }

  return declarations;

  function addDeclaration(type: EmittedNamedType): EmittedNamedType | undefined {
    const declaration = resolveTemplateDeclaration(program, type);
    if (!shouldEmitNamedType(program, declaration)) return undefined;

    const key = getNamedTypeKey(declaration);
    if (!included.has(key)) {
      included.add(key);
      declarations.push(declaration);
    }
    return declaration;
  }

  function visitType(type: Type): void {
    switch (type.kind) {
      case "Model": {
        for (const argument of type.templateMapper?.args ?? []) visitEntity(argument);
        if (isPureRecordModel(type)) {
          for (const value of getAdditionalPropertiesValues(type)) visitType(value);
          return;
        }
        if (isArrayModelType(program, type) || isTypeSpecCollectionModel(type)) {
          if (type.indexer) visitType(type.indexer.value);
          return;
        }
        const httpPartType = getHttpPartType(program, type);
        if (httpPartType) {
          visitType(httpPartType);
          return;
        }
        if (isHttpFileModel(program, type)) return;
        if (!type.name) {
          if (type.baseModel) visitType(type.baseModel);
          for (const property of type.properties.values()) visitType(property.type);
          for (const additionalType of getAdditionalPropertiesValues(type)) {
            visitType(additionalType);
          }
          return;
        }
        const declaration = addDeclaration(type);
        if (declaration) expandDeclaration(declaration);
        return;
      }
      case "Scalar": {
        for (const argument of type.templateMapper?.args ?? []) visitEntity(argument);
        const declaration = addDeclaration(type);
        if (declaration) expandDeclaration(declaration);
        return;
      }
      case "Enum": {
        addDeclaration(type);
        return;
      }
      case "Union": {
        for (const argument of type.templateMapper?.args ?? []) visitEntity(argument);
        const declaration = addDeclaration(type);
        if (declaration) expandDeclaration(declaration);
        return;
      }
      case "Tuple":
        for (const value of type.values) visitType(value);
        return;
      case "ModelProperty":
      case "UnionVariant":
        visitType(type.type);
        return;
      default:
        return;
    }
  }

  function visitEntity(entity: unknown): void {
    if (!isEntityLike(entity)) return;
    if (isType(entity)) {
      visitType(entity);
    } else if (isValue(entity)) {
      const exactType = program.checker.getValueExactType(entity as Value);
      if (exactType) visitType(exactType);
    }
  }

  function expandDeclaration(type: EmittedNamedType): void {
    const key = getNamedTypeKey(type);
    if (expanded.has(key)) return;
    expanded.add(key);

    switch (type.kind) {
      case "Model":
        if (type.baseModel) visitType(type.baseModel);
        for (const property of type.properties.values()) visitType(property.type);
        {
          for (const additionalType of getAdditionalPropertiesValues(type)) {
            visitType(additionalType);
          }
        }
        break;
      case "Scalar":
        if (type.baseScalar) visitType(type.baseScalar);
        break;
      case "Union":
        for (const variant of type.variants.values()) visitType(variant.type);
        break;
      case "Enum":
        break;
    }
  }
}

export function getNamedTypeKey(type: EmittedNamedType): string {
  return `${type.kind}:${getNamespaceFullName(type.namespace)}.${type.name}`;
}

function collectNamespaceDeclarations(
  program: Program,
  namespace: Namespace,
  add: (type: EmittedNamedType) => void,
): void {
  for (const model of namespace.models.values()) {
    if (shouldEmitNamedType(program, model)) add(model);
  }
  for (const scalar of namespace.scalars.values()) {
    if (shouldEmitNamedType(program, scalar)) add(scalar);
  }
  for (const enumType of namespace.enums.values()) {
    if (shouldEmitNamedType(program, enumType)) add(enumType);
  }
  for (const union of namespace.unions.values()) {
    if (shouldEmitNamedType(program, union)) add(union);
  }
  for (const child of namespace.namespaces.values()) {
    collectNamespaceDeclarations(program, child, add);
  }
}

function shouldEmitNamedType(program: Program, type: EmittedNamedType): boolean {
  if (!type.name || isTypeSpecNamespace(type.namespace)) return false;
  if (type.kind !== "Model") return true;
  return (
    !isArrayModelType(program, type) &&
    !isPureRecordModel(type) &&
    !isHttpPartModel(program, type) &&
    !isHttpFileModel(program, type)
  );
}

function resolveTemplateDeclaration<T extends EmittedNamedType>(program: Program, type: T): T {
  if (!("templateNode" in type) || !type.templateNode) return type;
  const declaration = program.checker.getTypeForNode(type.templateNode);
  return declaration.kind === type.kind ? (declaration as T) : type;
}

function isTypeSpecCollectionModel(model: Model): boolean {
  return (
    getNamespaceFullName(model.namespace) === "TypeSpec" &&
    (model.name === "Array" || model.name === "Record")
  );
}

function isTypeSpecNamespace(namespace: Namespace | undefined): boolean {
  let current = namespace;
  while (current) {
    if (current.name === "TypeSpec") return true;
    current = current.namespace;
  }
  return false;
}
