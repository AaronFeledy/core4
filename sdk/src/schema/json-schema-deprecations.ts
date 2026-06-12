import { JSONSchema, type Schema } from "effect";
import * as AST from "effect/SchemaAST";

import {
  type DeprecationNotice,
  formatDeprecationNotice,
  getSchemaDeprecation,
  validateDeprecationNotice,
} from "./deprecation.ts";

type JsonObject = Record<string, unknown>;
type SchemaLike = Schema.Schema.All;
type JsonSchemaInput = Parameters<typeof JSONSchema.make>[0];
type TupleElement = AST.OptionalType | AST.Type;

const cloneJson = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

const jsonObject = (value: unknown): JsonObject | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? (value as JsonObject) : undefined;

const findSchemaDeprecation = (ast: AST.AST): DeprecationNotice | undefined => {
  const notice = getSchemaDeprecation(ast);
  if (notice !== undefined) return notice;

  if (AST.isRefinement(ast)) return findSchemaDeprecation(ast.from);
  if (AST.isSuspend(ast)) return findSchemaDeprecation(ast.f());
  if (AST.isUnion(ast)) {
    for (const member of ast.types) {
      const memberNotice = findSchemaDeprecation(member);
      if (memberNotice !== undefined) return memberNotice;
    }
  }

  return undefined;
};

const findTupleElementDeprecation = (element: TupleElement): DeprecationNotice | undefined =>
  getSchemaDeprecation(element) ?? findSchemaDeprecation(element.type);

const findSchemaReferenceDeprecation = (ast: AST.AST): DeprecationNotice | undefined => {
  const notice = findSchemaDeprecation(ast);
  if (notice !== undefined) return notice;

  if (AST.isTupleType(ast)) {
    for (const element of ast.elements) {
      const elementNotice = getSchemaDeprecation(element) ?? findSchemaReferenceDeprecation(element.type);
      if (elementNotice !== undefined) return elementNotice;
    }
    for (const rest of ast.rest) {
      const restNotice = getSchemaDeprecation(rest) ?? findSchemaReferenceDeprecation(rest.type);
      if (restNotice !== undefined) return restNotice;
    }
  }

  return undefined;
};

const setDeprecation = (target: unknown, notice: DeprecationNotice | undefined): void => {
  if (target === null || typeof target !== "object") return;
  if (notice === undefined) return;
  const record = target as JsonObject;
  record.deprecated = true;
  record["x-deprecation"] = notice;
};

const applyDeprecation = (target: unknown, ast: AST.AST): void =>
  setDeprecation(target, findSchemaDeprecation(ast));

const schemaProperties = (target: unknown): Record<string, unknown> | undefined => {
  const properties = jsonObject(target)?.properties;
  return properties !== null && typeof properties === "object" && !Array.isArray(properties)
    ? (properties as Record<string, unknown>)
    : undefined;
};

const applyTupleElementDeprecations = (target: unknown, element: TupleElement): void => {
  setDeprecation(target, findTupleElementDeprecation(element));
  applyDeprecationsFromAst(target, element.type);
};

const applyTupleDeprecations = (target: unknown, ast: AST.TupleType): void => {
  const targetObject = jsonObject(target);
  if (targetObject === undefined) return;

  const fixedItems = Array.isArray(targetObject.prefixItems)
    ? targetObject.prefixItems
    : Array.isArray(targetObject.items)
      ? targetObject.items
      : undefined;

  if (fixedItems !== undefined) {
    for (const [index, element] of ast.elements.entries()) {
      const itemSchema = fixedItems[index];
      if (itemSchema !== undefined) applyTupleElementDeprecations(itemSchema, element);
    }
  }

  const restSchema = Array.isArray(targetObject.items) ? targetObject.additionalItems : targetObject.items;
  const rest = ast.rest[0];
  if (rest !== undefined && restSchema !== undefined) applyTupleElementDeprecations(restSchema, rest);
};

const applyDeprecationsFromAst = (target: unknown, ast: AST.AST): void => {
  applyDeprecation(target, ast);

  if (AST.isRefinement(ast)) {
    applyDeprecationsFromAst(target, ast.from);
    return;
  }

  if (AST.isSuspend(ast)) {
    applyDeprecationsFromAst(target, ast.f());
    return;
  }

  if (AST.isUnion(ast)) {
    for (const member of ast.types) applyDeprecationsFromAst(target, member);
    return;
  }

  if (AST.isTupleType(ast)) {
    applyTupleDeprecations(target, ast);
    return;
  }

  if (AST.isTypeLiteral(ast)) {
    const properties = schemaProperties(target);
    if (properties === undefined) return;
    for (const property of ast.propertySignatures) {
      if (typeof property.name !== "string") continue;
      const propertySchema = properties[property.name];
      if (propertySchema === undefined) continue;
      setDeprecation(propertySchema, getSchemaDeprecation(property));
      applyDeprecationsFromAst(propertySchema, property.type);
    }
  }
};

export const withSchemaDeprecations = <S extends SchemaLike>(schema: S, jsonSchema: unknown): unknown => {
  const copy = cloneJson(jsonSchema);
  applyDeprecationsFromAst(copy, schema.ast);
  return copy;
};

export const getJsonSchemaWithDeprecations = <S extends SchemaLike>(schema: S): unknown =>
  withSchemaDeprecations(schema, JSONSchema.make(schema as JsonSchemaInput));

const validateJsonSchemaDeprecations = (value: unknown, path: string, invalidPaths: string[]): void => {
  if (Array.isArray(value)) {
    value.forEach((child, index) => validateJsonSchemaDeprecations(child, `${path}[${index}]`, invalidPaths));
    return;
  }
  if (value === null || typeof value !== "object") return;

  const record = value as JsonObject;
  if (Object.hasOwn(record, "x-deprecation") && !validateDeprecationNotice(record["x-deprecation"])) {
    invalidPaths.push(path);
  }

  for (const [key, child] of Object.entries(record)) {
    validateJsonSchemaDeprecations(child, path === "$" ? `$.${key}` : `${path}.${key}`, invalidPaths);
  }
};

export const assertJsonSchemaDeprecationsValid = (jsonSchema: unknown): readonly string[] => {
  const invalidPaths: string[] = [];
  validateJsonSchemaDeprecations(jsonSchema, "$", invalidPaths);
  return invalidPaths;
};

const schemaTitle = (name: string, ast: AST.AST): string => {
  const title = ast.annotations[AST.TitleAnnotationId];
  return typeof title === "string" ? title : name;
};

const schemaDescription = (ast: AST.AST): string | undefined => {
  const description = ast.annotations[AST.DescriptionAnnotationId];
  return typeof description === "string" ? description : undefined;
};

export const renderSchemaReferenceMarkdown = <S extends SchemaLike>(name: string, schema: S): string => {
  const lines: string[] = [`# ${schemaTitle(name, schema.ast)}`, ""];
  const description = schemaDescription(schema.ast);
  if (description !== undefined) lines.push(description, "");

  const notice = getSchemaDeprecation(schema.ast);
  if (notice !== undefined) lines.push("> [!WARNING]", `> ${formatDeprecationNotice(notice)}`, "");

  const ast = AST.isRefinement(schema.ast) ? schema.ast.from : schema.ast;
  if (AST.isTypeLiteral(ast) && ast.propertySignatures.length > 0) {
    const rows: string[] = [];
    for (const property of ast.propertySignatures) {
      if (typeof property.name !== "string") continue;
      const propertyNotice = getSchemaDeprecation(property) ?? findSchemaReferenceDeprecation(property.type);
      if (propertyNotice === undefined) continue;
      rows.push(`| \`${property.name}\` | ${formatDeprecationNotice(propertyNotice)} |`);
    }
    if (rows.length > 0) lines.push("| Field | Deprecation |", "| --- | --- |", ...rows, "");
  }

  return `${lines.join("\n").trimEnd()}\n`;
};
