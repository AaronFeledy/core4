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
type TraversalContext = { readonly root: JsonObject };

const cloneJson = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

const jsonObject = (value: unknown): JsonObject | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? (value as JsonObject) : undefined;

const findSchemaDeprecation = (ast: AST.AST): DeprecationNotice | undefined => {
  const notice = getSchemaDeprecation(ast);
  if (notice !== undefined) return notice;

  if (AST.isRefinement(ast)) return findSchemaDeprecation(ast.from);
  if (AST.isSuspend(ast)) return findSchemaDeprecation(ast.f());
  if (AST.isTransformation(ast)) return findSchemaDeprecation(ast.from);
  if (AST.isUnion(ast)) {
    for (const member of ast.types) {
      const memberNotice = findSchemaDeprecation(member);
      if (memberNotice !== undefined) return memberNotice;
    }
  }

  return undefined;
};

const findJsonNodeDeprecation = (ast: AST.AST): DeprecationNotice | undefined => {
  const notice = getSchemaDeprecation(ast);
  if (notice !== undefined) return notice;

  if (AST.isRefinement(ast)) return findJsonNodeDeprecation(ast.from);
  if (AST.isSuspend(ast)) return findJsonNodeDeprecation(ast.f());
  if (AST.isTransformation(ast)) return findJsonNodeDeprecation(ast.from);
  return undefined;
};

const findTupleElementDeprecation = (element: TupleElement): DeprecationNotice | undefined =>
  getSchemaDeprecation(element) ?? findSchemaDeprecation(element.type);

const schemaReferenceAst = (ast: AST.AST): AST.AST => {
  if (AST.isRefinement(ast)) return schemaReferenceAst(ast.from);
  if (AST.isSuspend(ast)) return schemaReferenceAst(ast.f());
  if (AST.isTransformation(ast)) return schemaReferenceAst(ast.from);
  return ast;
};

const findSchemaReferenceDeprecation = (ast: AST.AST): DeprecationNotice | undefined => {
  const notice = findSchemaDeprecation(ast);
  if (notice !== undefined) return notice;

  const referenceAst = schemaReferenceAst(ast);
  if (AST.isTupleType(referenceAst)) {
    for (const element of referenceAst.elements) {
      const elementNotice = getSchemaDeprecation(element) ?? findSchemaReferenceDeprecation(element.type);
      if (elementNotice !== undefined) return elementNotice;
    }
    for (const rest of referenceAst.rest) {
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
  setDeprecation(target, findJsonNodeDeprecation(ast));

const decodeJsonPointerSegment = (segment: string): string => {
  const decoded = segment.includes("%") ? decodeURIComponent(segment) : segment;
  return decoded.replace(/~1/g, "/").replace(/~0/g, "~");
};

const localRefTarget = (target: unknown, context: TraversalContext): unknown => {
  const ref = jsonObject(target)?.$ref;
  if (typeof ref !== "string" || !ref.startsWith("#/")) return undefined;

  let current: unknown = context.root;
  for (const segment of ref.slice(2).split("/").map(decodeJsonPointerSegment)) {
    const currentObject = jsonObject(current);
    if (currentObject === undefined) return undefined;
    current = currentObject[segment];
  }
  return current;
};

const jsonSchemaTarget = (target: unknown, context: TraversalContext): unknown =>
  localRefTarget(target, context) ?? target;

const schemaProperties = (target: unknown): Record<string, unknown> | undefined => {
  const properties = jsonObject(target)?.properties;
  return properties !== null && typeof properties === "object" && !Array.isArray(properties)
    ? (properties as Record<string, unknown>)
    : undefined;
};

const unionBranchSchemas = (target: unknown): readonly unknown[] | undefined => {
  const targetObject = jsonObject(target);
  if (targetObject === undefined) return undefined;
  if (Array.isArray(targetObject.anyOf)) return targetObject.anyOf;
  if (Array.isArray(targetObject.oneOf)) return targetObject.oneOf;
  return undefined;
};

const applyTupleElementDeprecations = (
  target: unknown,
  element: TupleElement,
  context: TraversalContext,
): void => {
  setDeprecation(target, findTupleElementDeprecation(element));
  applyDeprecationsFromAst(target, element.type, context);
};

const applyTupleDeprecations = (target: unknown, ast: AST.TupleType, context: TraversalContext): void => {
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
      if (itemSchema !== undefined) applyTupleElementDeprecations(itemSchema, element, context);
    }
  }

  const restSchema = Array.isArray(targetObject.items) ? targetObject.additionalItems : targetObject.items;
  const rest = ast.rest[0];
  if (rest !== undefined && restSchema !== undefined)
    applyTupleElementDeprecations(restSchema, rest, context);
};

const emittedUnionMember = (ast: AST.Union): AST.AST | undefined => {
  const emittedMembers = ast.types.filter(
    (member) => member._tag !== "UndefinedKeyword" && member._tag !== "NeverKeyword",
  );
  return emittedMembers.length === 1 ? emittedMembers[0] : undefined;
};

const applyUnionDeprecations = (target: unknown, ast: AST.Union, context: TraversalContext): void => {
  const branches = unionBranchSchemas(target);
  if (branches !== undefined) {
    const emittedMembers = ast.types.filter(
      (member) => member._tag !== "UndefinedKeyword" && member._tag !== "NeverKeyword",
    );
    if (branches.length === emittedMembers.length) {
      for (const [index, member] of emittedMembers.entries())
        applyDeprecationsFromAst(branches[index], member, context);
      return;
    }
  }

  const member = emittedUnionMember(ast);
  if (member !== undefined) applyDeprecationsFromAst(target, member, context);
};

const indexSignatureJsonSchema = (target: unknown, signature: AST.IndexSignature): unknown => {
  const targetObject = jsonObject(target);
  if (targetObject === undefined) return undefined;

  switch (signature.parameter._tag) {
    case "StringKeyword":
    case "SymbolKeyword":
      return targetObject.additionalProperties;
    case "TemplateLiteral":
    case "Refinement":
      return Object.values(jsonObject(targetObject.patternProperties) ?? {})[0];
  }
};

const applyIndexSignatureDeprecations = (
  target: unknown,
  ast: AST.TypeLiteral,
  context: TraversalContext,
): void => {
  for (const signature of ast.indexSignatures) {
    const indexSchema = indexSignatureJsonSchema(target, signature);
    if (indexSchema !== undefined) applyDeprecationsFromAst(indexSchema, signature.type, context);
  }
};

const applyDeprecationsFromAst = (target: unknown, ast: AST.AST, context: TraversalContext): void => {
  const targetSchema = jsonSchemaTarget(target, context);

  if (AST.isUnion(ast)) {
    setDeprecation(targetSchema, getSchemaDeprecation(ast));
    applyUnionDeprecations(targetSchema, ast, context);
    return;
  }

  applyDeprecation(targetSchema, ast);

  if (AST.isRefinement(ast)) {
    applyDeprecationsFromAst(targetSchema, ast.from, context);
    return;
  }

  if (AST.isSuspend(ast)) {
    applyDeprecationsFromAst(targetSchema, ast.f(), context);
    return;
  }

  if (AST.isTransformation(ast)) {
    applyDeprecationsFromAst(targetSchema, ast.from, context);
    return;
  }

  if (AST.isTupleType(ast)) {
    applyTupleDeprecations(targetSchema, ast, context);
    return;
  }

  if (AST.isTypeLiteral(ast)) {
    const properties = schemaProperties(targetSchema);
    if (properties !== undefined) {
      for (const property of ast.propertySignatures) {
        if (typeof property.name !== "string") continue;
        const propertySchema = properties[property.name];
        if (propertySchema === undefined) continue;
        setDeprecation(propertySchema, getSchemaDeprecation(property));
        applyDeprecationsFromAst(propertySchema, property.type, context);
      }
    }
    applyIndexSignatureDeprecations(targetSchema, ast, context);
  }
};

export const withSchemaDeprecations = <S extends SchemaLike>(schema: S, jsonSchema: unknown): unknown => {
  const copy = cloneJson(jsonSchema);
  const root = jsonObject(copy);
  if (root !== undefined) applyDeprecationsFromAst(root, schema.ast, { root });
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

export interface SchemaDeprecationEntry {
  readonly path: string;
  readonly notice: DeprecationNotice;
}

const collectJsonSchemaDeprecations = (
  value: unknown,
  path: string,
  entries: Array<SchemaDeprecationEntry>,
): void => {
  if (Array.isArray(value)) {
    value.forEach((child, index) => collectJsonSchemaDeprecations(child, `${path}[${index}]`, entries));
    return;
  }
  if (value === null || typeof value !== "object") return;

  const record = value as JsonObject;
  const notice = record["x-deprecation"];
  if (validateDeprecationNotice(notice)) entries.push({ path, notice });

  for (const [key, child] of Object.entries(record)) {
    collectJsonSchemaDeprecations(child, path === "$" ? `$.${key}` : `${path}.${key}`, entries);
  }
};

export const schemaDeprecationsFromJsonSchema = (
  jsonSchema: unknown,
): ReadonlyArray<SchemaDeprecationEntry> => {
  const entries: Array<SchemaDeprecationEntry> = [];
  collectJsonSchemaDeprecations(jsonSchema, "$", entries);
  return entries;
};

const schemaTitle = (name: string, ast: AST.AST): string => {
  const title = ast.annotations[AST.TitleAnnotationId];
  return typeof title === "string" ? title : name;
};

const schemaDescription = (ast: AST.AST): string | undefined => {
  const description = ast.annotations[AST.DescriptionAnnotationId];
  return typeof description === "string" ? description : undefined;
};

const frontmatterString = (value: string): string =>
  /^[A-Za-z0-9 ._-]+$/.test(value) ? value : JSON.stringify(value);

const markdownCell = (value: string): string => value.replace(/\|/g, "\\|").replace(/\n+/g, " ");

const codeValue = (value: unknown): string => `\`${String(value)}\``;

const resolveRootJsonSchemaRef = (jsonSchema: JsonObject): JsonObject => {
  const ref = typeof jsonSchema.$ref === "string" ? jsonSchema.$ref : undefined;
  if (ref?.startsWith("#/$defs/")) {
    const key = ref.slice("#/$defs/".length);
    const defs = jsonObject(jsonSchema.$defs);
    const resolved = defs === undefined ? undefined : jsonObject(defs[key]);
    if (resolved !== undefined) return resolved;
  }
  return jsonSchema;
};

const schemaReferenceJsonObject = (schema: SchemaLike): JsonObject =>
  resolveRootJsonSchemaRef(JSONSchema.make(schema as JsonSchemaInput) as unknown as JsonObject);

const fieldDescription = (property: AST.PropertySignature): string | undefined => {
  const own = property.annotations[AST.DescriptionAnnotationId];
  if (typeof own === "string") return own;
  return schemaDescription(property.type);
};

const unwrapUndefinedUnion = (ast: AST.AST): AST.AST => {
  if (!AST.isUnion(ast)) return ast;
  const nonUndefined = ast.types.filter((member) => member._tag !== "UndefinedKeyword");
  return nonUndefined.length === 1 ? (nonUndefined[0] as AST.AST) : ast;
};

const fieldType = (property: AST.PropertySignature, jsonSchema: JsonObject | undefined): string => {
  const type = typeof jsonSchema?.type === "string" ? jsonSchema.type : undefined;
  if (type !== undefined) return codeValue(type);
  if (Array.isArray(jsonSchema?.enum) && jsonSchema.enum.length > 0) {
    const enumTypes = new Set(jsonSchema.enum.map((value) => typeof value));
    if (enumTypes.size === 1) return codeValue(enumTypes.values().next().value);
  }
  const ast = schemaReferenceAst(unwrapUndefinedUnion(property.type));
  if (AST.isUnion(ast) && ast.types.every((member) => member._tag === "Literal")) return "literal";
  if (ast._tag === "StringKeyword") return "`string`";
  if (ast._tag === "NumberKeyword") return "`number`";
  if (ast._tag === "BooleanKeyword") return "`boolean`";
  if (AST.isTupleType(ast)) return "`array`";
  if (AST.isTypeLiteral(ast)) return "`object`";
  return "—";
};

const literalValues = (ast: AST.AST): ReadonlyArray<unknown> => {
  const unwrapped = schemaReferenceAst(unwrapUndefinedUnion(ast));
  if (unwrapped._tag === "Literal" && "literal" in unwrapped) return [unwrapped.literal];
  if (AST.isUnion(unwrapped)) return unwrapped.types.flatMap(literalValues);
  return [];
};

const acceptedValues = (property: AST.PropertySignature, jsonSchema: JsonObject | undefined): string => {
  const values = Array.isArray(jsonSchema?.enum) ? jsonSchema.enum : literalValues(property.type);
  return values.length > 0 ? values.map(codeValue).join(", ") : "—";
};

const examples = (property: AST.PropertySignature): string => {
  const values = property.type.annotations[AST.ExamplesAnnotationId];
  return !Array.isArray(values) || values.length === 0
    ? "—"
    : values.map((value) => codeValue(JSON.stringify(value))).join(", ");
};

const defaultValue = (jsonSchema: JsonObject | undefined): string =>
  Object.hasOwn(jsonSchema ?? {}, "default") ? codeValue(JSON.stringify(jsonSchema?.default)) : "—";

const schemaExamples = (ast: AST.AST): string => {
  const values = ast.annotations[AST.ExamplesAnnotationId];
  return !Array.isArray(values) || values.length === 0
    ? "—"
    : values.map((value) => codeValue(JSON.stringify(value))).join(", ");
};

const schemaAcceptedValues = (ast: AST.AST, jsonSchema: JsonObject): string => {
  const values = Array.isArray(jsonSchema.enum) ? jsonSchema.enum : literalValues(ast);
  return values.length > 0 ? values.map(codeValue).join(", ") : "—";
};

export const renderSchemaReferenceMarkdown = <S extends SchemaLike>(
  name: string,
  schema: S,
  options: {
    readonly jsonSchema?: JsonObject;
    readonly jsonSchemaPath?: string;
    readonly title?: string;
    readonly description?: string;
  } = {},
): string => {
  const title = options.title ?? schemaTitle(name, schema.ast);
  const description = options.description ?? schemaDescription(schema.ast);
  const jsonSchemaPath = options.jsonSchemaPath;
  const lines: string[] = [
    "---",
    `title: ${frontmatterString(title)}`,
    ...(description === undefined ? [] : [`description: ${frontmatterString(description)}`]),
    "---",
    "",
    `# ${title}`,
    "",
  ];
  if (description !== undefined) lines.push(description, "");
  if (jsonSchemaPath !== undefined) {
    lines.push(`[JSON Schema artifact](../../../${jsonSchemaPath})`, "");
  }

  const notice = getSchemaDeprecation(schema.ast);
  if (notice !== undefined) lines.push("> [!WARNING]", `> ${formatDeprecationNotice(notice)}`, "");

  const jsonSchema =
    options.jsonSchema === undefined
      ? schemaReferenceJsonObject(schema)
      : resolveRootJsonSchemaRef(options.jsonSchema);
  const ast = schemaReferenceAst(schema.ast);
  if (AST.isTypeLiteral(ast)) {
    const properties = jsonObject(jsonSchema.properties);
    const rows: string[] = [
      "| Field | Required | Type | Description | Default | Accepted values | Examples | Deprecation |",
      "| --- | --- | --- | --- | --- | --- | --- | --- |",
    ];
    for (const property of ast.propertySignatures) {
      if (typeof property.name !== "string") continue;
      const propertySchema = properties === undefined ? undefined : jsonObject(properties[property.name]);
      const propertyNotice = getSchemaDeprecation(property) ?? findSchemaReferenceDeprecation(property.type);
      rows.push(
        [
          codeValue(property.name),
          property.isOptional ? "No" : "Yes",
          fieldType(property, propertySchema),
          fieldDescription(property) ?? "—",
          defaultValue(propertySchema),
          acceptedValues(property, propertySchema),
          examples(property),
          propertyNotice === undefined ? "—" : formatDeprecationNotice(propertyNotice),
        ]
          .map(markdownCell)
          .join(" | ")
          .replace(/^/, "| ")
          .replace(/$/, " |"),
      );
    }
    lines.push(...rows, "");
  } else {
    const rows = [
      "| Type | Default | Accepted values | Examples |",
      "| --- | --- | --- | --- |",
      [
        typeof jsonSchema.type === "string" ? codeValue(jsonSchema.type) : "—",
        defaultValue(jsonSchema),
        schemaAcceptedValues(ast, jsonSchema),
        schemaExamples(schema.ast),
      ]
        .map(markdownCell)
        .join(" | ")
        .replace(/^/, "| ")
        .replace(/$/, " |"),
    ];
    lines.push("## Schema details", "", ...rows, "");
  }

  return `${lines.join("\n").trimEnd()}\n`;
};
