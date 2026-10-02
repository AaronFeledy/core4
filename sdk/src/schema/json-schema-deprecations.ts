import { JsonSchema, Schema } from "effect";
import * as AST from "effect/SchemaAST";

import {
  type DeprecationNotice,
  formatDeprecationNotice,
  getSchemaDeprecation,
  validateDeprecationNotice,
} from "./deprecation.ts";

type JsonObject = Record<string, unknown>;
type SchemaLike = Schema.Top;
type TupleElement = AST.AST;
type TraversalContext = {
  readonly root: JsonObject;
  /**
   * Guard against recursive schemas. A `Suspend` unrolls to the same AST node
   * every time, so a self-referential grammar would otherwise re-enter the same
   * target forever instead of terminating at its emitted reference.
   */
  readonly visited: WeakMap<object, WeakSet<object>>;
};

const alreadyVisited = (target: unknown, ast: AST.AST, context: TraversalContext): boolean => {
  if (target === null || typeof target !== "object") return false;
  const seen = context.visited.get(target as object);
  if (seen === undefined) {
    context.visited.set(target as object, new WeakSet([ast as unknown as object]));
    return false;
  }
  if (seen.has(ast as unknown as object)) return true;
  seen.add(ast as unknown as object);
  return false;
};

const cloneJson = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

const jsonObject = (value: unknown): JsonObject | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? (value as JsonObject) : undefined;

const findSchemaDeprecation = (ast: AST.AST): DeprecationNotice | undefined => {
  const notice = getSchemaDeprecation(ast);
  if (notice !== undefined) return notice;

  if (AST.isSuspend(ast)) return findSchemaDeprecation(ast.thunk());
  if (ast.encoding !== undefined) return findSchemaDeprecation(AST.toEncoded(ast));
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

  if (AST.isSuspend(ast)) return findJsonNodeDeprecation(ast.thunk());
  if (ast.encoding !== undefined) return findJsonNodeDeprecation(AST.toEncoded(ast));
  return undefined;
};

const findTupleElementDeprecation = (element: TupleElement): DeprecationNotice | undefined =>
  getSchemaDeprecation(element) ?? findSchemaDeprecation(element);

const schemaReferenceAst = (ast: AST.AST): AST.AST => {
  if (AST.isSuspend(ast)) return schemaReferenceAst(ast.thunk());
  if (ast.encoding !== undefined) return schemaReferenceAst(AST.toEncoded(ast));
  return ast;
};

const findSchemaReferenceDeprecation = (ast: AST.AST): DeprecationNotice | undefined => {
  const notice = findSchemaDeprecation(ast);
  if (notice !== undefined) return notice;

  const referenceAst = schemaReferenceAst(ast);
  if (AST.isArrays(referenceAst)) {
    for (const element of referenceAst.elements) {
      const elementNotice = getSchemaDeprecation(element) ?? findSchemaReferenceDeprecation(element);
      if (elementNotice !== undefined) return elementNotice;
    }
    for (const rest of referenceAst.rest) {
      const restNotice = getSchemaDeprecation(rest) ?? findSchemaReferenceDeprecation(rest);
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

const localRefTarget = (target: unknown, context: Pick<TraversalContext, "root">): unknown => {
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
  applyDeprecationsFromAst(target, element, context);
};

const applyTupleDeprecations = (target: unknown, ast: AST.Arrays, context: TraversalContext): void => {
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
  const emittedMembers = ast.types.filter((member) => member._tag !== "Never");
  return emittedMembers.length === 1 ? emittedMembers[0] : undefined;
};

const applyUnionDeprecations = (target: unknown, ast: AST.Union, context: TraversalContext): void => {
  const branches = unionBranchSchemas(target);
  if (branches !== undefined) {
    const emittedMembers = ast.types.filter((member) => member._tag !== "Never");
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
    case "String":
    case "Symbol":
      return signature.parameter.checks === undefined
        ? targetObject.additionalProperties
        : Object.values(jsonObject(targetObject.patternProperties) ?? {})[0];
    case "TemplateLiteral":
      return Object.values(jsonObject(targetObject.patternProperties) ?? {})[0];
  }
};

const applyIndexSignatureDeprecations = (
  target: unknown,
  ast: AST.Objects,
  context: TraversalContext,
): void => {
  for (const signature of ast.indexSignatures) {
    const indexSchema = indexSignatureJsonSchema(target, signature);
    if (indexSchema !== undefined) applyDeprecationsFromAst(indexSchema, signature.type, context);
  }
};

const applyDeprecationsFromAst = (target: unknown, ast: AST.AST, context: TraversalContext): void => {
  const targetSchema = jsonSchemaTarget(target, context);
  if (alreadyVisited(targetSchema, ast, context)) return;

  const projection = jsonObject(ast.annotations?.jsonSchemaProjection);
  const targetObject = jsonObject(targetSchema);
  if (projection !== undefined && targetObject !== undefined) {
    for (const key of Object.keys(targetObject)) delete targetObject[key];
    Object.assign(targetObject, cloneJson(projection));
    const description = AST.resolveDescription(ast);
    if (description !== undefined) targetObject.description = description;
    return;
  }

  if (AST.isUnion(ast)) {
    setDeprecation(targetSchema, getSchemaDeprecation(ast));
    applyUnionDeprecations(targetSchema, ast, context);
    return;
  }

  applyDeprecation(targetSchema, ast);

  if (AST.isSuspend(ast)) {
    applyDeprecationsFromAst(targetSchema, ast.thunk(), context);
    return;
  }

  if (ast.encoding !== undefined) {
    applyDeprecationsFromAst(targetSchema, AST.toEncoded(ast), context);
    return;
  }

  if (AST.isArrays(ast)) {
    applyTupleDeprecations(targetSchema, ast, context);
    return;
  }

  if (AST.isObjects(ast)) {
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
  if (root !== undefined) applyDeprecationsFromAst(root, schema.ast, { root, visited: new WeakMap() });
  return copy;
};

const jsonInputAst = (root: AST.AST): AST.AST => {
  const memo = new WeakMap<AST.AST, AST.AST>();
  const visit = (ast: AST.AST): AST.AST => {
    const cached = memo.get(ast);
    if (cached !== undefined) return cached;
    let result: AST.AST;
    switch (ast._tag) {
      case "Number":
        // JSON numbers are finite; do not widen file artifacts to Effect's non-finite string codec.
        result = new AST.Number(
          ast.annotations,
          [
            ...(ast.checks ?? []),
            Schema.isFinite({
              identifier: AST.resolveIdentifier(ast),
              title: AST.resolveTitle(ast),
              description: AST.resolveDescription(ast),
            }),
          ],
          undefined,
          ast.context,
        );
        break;
      case "Objects":
        result = new AST.Objects(
          ast.propertySignatures.map(
            (property) => new AST.PropertySignature(property.name, visit(property.type)),
          ),
          ast.indexSignatures.map(
            (index) => new AST.IndexSignature(visit(index.parameter), visit(index.type)),
          ),
          ast.annotations,
          ast.checks,
          undefined,
          ast.context,
          ast.encodingChecks,
        );
        break;
      case "Arrays":
        result = new AST.Arrays(
          ast.isMutable,
          ast.elements.map(visit),
          ast.rest.map(visit),
          ast.annotations,
          ast.checks,
          undefined,
          ast.context,
          ast.encodingChecks,
        );
        break;
      case "Union":
        result = new AST.Union(
          ast.types.map(visit),
          ast.options,
          ast.annotations,
          ast.checks,
          undefined,
          ast.context,
          ast.encodingChecks,
        );
        break;
      case "Suspend":
        result = new AST.Suspend(
          () => visit(ast.thunk()),
          ast.annotations,
          ast.checks,
          undefined,
          ast.context,
        );
        break;
      default:
        result = ast;
    }
    memo.set(ast, result);
    return result;
  };
  return visit(AST.toEncoded(root));
};

export const getJsonSchemaWithDeprecations = <S extends SchemaLike>(
  schema: S,
  options: Schema.ToJsonSchemaOptions = { onExcessProperty: "error" },
): unknown => {
  const rootIdentifier = AST.resolveIdentifier(jsonInputAst(schema.ast));
  const document = JsonSchema.toDocumentDraft07(
    Schema.toJsonSchemaDocument(Schema.make<Schema.Codec<unknown>>(jsonInputAst(schema.ast)), {
      referencePolicy: ({ identifier }) => (identifier === rootIdentifier ? undefined : identifier),
      includeAnnotationKey: (key) => key === "acceptsImportRef",
      ...options,
    }),
  );
  return withSchemaDeprecations(schema, {
    $schema: JsonSchema.META_SCHEMA_URI_DRAFT_07,
    ...document.schema,
    ...(Object.keys(document.definitions).length === 0 ? {} : { definitions: document.definitions }),
  });
};

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
  const title = AST.resolveTitle(ast);
  return typeof title === "string" ? title : name;
};

const schemaDescription = (ast: AST.AST): string | undefined => {
  const description = AST.resolveDescription(ast);
  return typeof description === "string" ? description : undefined;
};

const frontmatterString = (value: string): string =>
  /^[A-Za-z0-9 ._-]+$/.test(value) ? value : JSON.stringify(value);

const mdxText = (value: string): string =>
  value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/{/g, "&#123;")
    .replace(/}/g, "&#125;");

const markdownCell = (value: string): string => value.replace(/\|/g, "\\|").replace(/\n+/g, " ");

const markdownTextCell = (value: string): string => mdxText(value);

const codeValue = (value: unknown): string => `\`${String(value)}\``;

const resolveLocalSchemaRef = (target: JsonObject, root: JsonObject): JsonObject | undefined => {
  const resolved = jsonObject(localRefTarget(target, { root }));
  if (resolved === undefined) return undefined;
  const defs = jsonObject(root.definitions ?? root.$defs);
  return defs === undefined ? resolved : { ...resolved, definitions: defs, $defs: defs };
};

const resolveRootJsonSchemaRef = (jsonSchema: JsonObject): JsonObject => {
  const resolved = resolveLocalSchemaRef(jsonSchema, jsonSchema);
  if (resolved === undefined) return jsonSchema;
  const defs = jsonObject(jsonSchema.definitions ?? jsonSchema.$defs);
  return defs === undefined ? resolved : { ...resolved, definitions: defs, $defs: defs };
};

const schemaReferenceJsonObject = (schema: SchemaLike): JsonObject =>
  resolveRootJsonSchemaRef(getJsonSchemaWithDeprecations(schema) as JsonObject);

const fieldDescription = (property: AST.PropertySignature): string | undefined => {
  const own = property.type.context?.annotations?.description;
  if (typeof own === "string") return own;
  const description = schemaDescription(property.type) ?? property.type.annotations?.description;
  if (typeof description === "string") return description;
  if (AST.isOptional(property.type)) return undefined;
  const expected = AST.resolveAt<unknown>("expected")(property.type);
  if (typeof expected === "string") return expected;
  switch (property.type._tag) {
    case "String":
      return "a string";
    case "Number":
      return "a number";
    case "Boolean":
      return "a boolean";
    default:
      return undefined;
  }
};

const unwrapUndefinedUnion = (ast: AST.AST): AST.AST => {
  if (!AST.isUnion(ast)) return ast;
  const nonUndefined = ast.types.filter((member) => member._tag !== "Undefined");
  return nonUndefined.length === 1 ? (nonUndefined[0] as AST.AST) : ast;
};

const jsonValueType = (value: unknown): string => {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
};

const jsonSchemaEnumValues = (jsonSchema: JsonObject | undefined): ReadonlyArray<unknown> => {
  if (jsonSchema === undefined) return [];
  const values = Array.isArray(jsonSchema.enum) ? [...jsonSchema.enum] : [];
  if (Object.hasOwn(jsonSchema, "const")) values.push(jsonSchema.const);
  return values;
};

const unionBranches = (
  jsonSchema: JsonObject | undefined,
  root: JsonObject = jsonSchema ?? {},
): ReadonlyArray<JsonObject> => {
  const branches = Array.isArray(jsonSchema?.anyOf)
    ? jsonSchema.anyOf
    : Array.isArray(jsonSchema?.oneOf)
      ? jsonSchema.oneOf
      : [];
  return branches.flatMap((branch) => {
    const branchObject = jsonObject(branch);
    if (branchObject === undefined) return [];
    return [resolveLocalSchemaRef(branchObject, root) ?? branchObject];
  });
};

const uniqueValues = (values: ReadonlyArray<unknown>): ReadonlyArray<unknown> => {
  const seen = new Set<string>();
  const unique: unknown[] = [];
  for (const value of values) {
    const key = JSON.stringify(value) ?? String(value);
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(value);
  }
  return unique;
};

const jsonSchemaAcceptedValues = (
  jsonSchema: JsonObject | undefined,
  root: JsonObject = jsonSchema ?? {},
): ReadonlyArray<unknown> => {
  const values: unknown[] = [];
  const collect = (schema: JsonObject): void => {
    const resolved = resolveLocalSchemaRef(schema, root) ?? schema;
    values.push(...jsonSchemaEnumValues(resolved));
    for (const branch of unionBranches(resolved, root)) collect(branch);
  };
  if (jsonSchema !== undefined) collect(jsonSchema);
  return uniqueValues(values);
};

const jsonSchemaTypes = (
  jsonSchema: JsonObject | undefined,
  root: JsonObject = jsonSchema ?? {},
): ReadonlyArray<string> => {
  const types = new Set<string>();
  const collect = (schema: JsonObject): void => {
    const resolved = resolveLocalSchemaRef(schema, root) ?? schema;
    if (typeof resolved.type === "string") types.add(resolved.type);
    for (const value of jsonSchemaEnumValues(resolved)) types.add(jsonValueType(value));
    for (const branch of unionBranches(resolved, root)) collect(branch);
  };
  if (jsonSchema !== undefined) collect(jsonSchema);
  return [...types];
};

const astDisplayType = (ast: AST.AST, options: { readonly showUnknown?: boolean } = {}): string => {
  const unwrapped = schemaReferenceAst(unwrapUndefinedUnion(ast));
  if (AST.isUnion(unwrapped) && unwrapped.types.every((member) => member._tag === "Literal"))
    return "literal";
  if (unwrapped._tag === "String") return "`string`";
  if (unwrapped._tag === "Number") return "`number`";
  if (unwrapped._tag === "Boolean") return "`boolean`";
  if (options.showUnknown === true && unwrapped._tag === "Unknown") return "`unknown`";
  if (AST.isArrays(unwrapped)) return "`array`";
  if (AST.isObjects(unwrapped)) return "`object`";
  return "—";
};

const astFieldType = (property: AST.PropertySignature): string => {
  const ast = schemaReferenceAst(unwrapUndefinedUnion(property.type));
  if (AST.isUnion(ast) && ast.types.every((member) => member._tag === "Literal")) return "literal";
  return astDisplayType(property.type);
};

const fieldType = (
  property: AST.PropertySignature | undefined,
  jsonSchemas: ReadonlyArray<JsonObject | undefined>,
  jsonSchemaRoot: JsonObject,
): string => {
  const jsonTypes = uniqueValues(
    jsonSchemas.flatMap((jsonSchema) => jsonSchemaTypes(jsonSchema, jsonSchemaRoot)),
  );
  if (jsonTypes.length > 0) return jsonTypes.map(codeValue).join(", ");
  return property === undefined ? "—" : astFieldType(property);
};

const literalValues = (ast: AST.AST): ReadonlyArray<unknown> => {
  const unwrapped = schemaReferenceAst(unwrapUndefinedUnion(ast));
  if (unwrapped._tag === "Literal" && "literal" in unwrapped) return [unwrapped.literal];
  if (AST.isUnion(unwrapped)) return unwrapped.types.flatMap(literalValues);
  return [];
};

const acceptedValues = (
  property: AST.PropertySignature | undefined,
  jsonSchemas: ReadonlyArray<JsonObject | undefined>,
  jsonSchemaRoot: JsonObject,
): string => {
  const values = uniqueValues(
    jsonSchemas.flatMap((jsonSchema) => jsonSchemaAcceptedValues(jsonSchema, jsonSchemaRoot)),
  );
  const fallbackValues = values.length > 0 || property === undefined ? values : literalValues(property.type);
  return fallbackValues.length > 0 ? fallbackValues.map(codeValue).join(", ") : "—";
};

const formattedJsonValue = (value: unknown): string =>
  typeof value === "string" ? String(value) : JSON.stringify(value);

const defaultValue = (jsonSchema: JsonObject | undefined): string =>
  Object.hasOwn(jsonSchema ?? {}, "default") ? codeValue(formattedJsonValue(jsonSchema?.default)) : "—";

const exampleValue = (value: unknown): string =>
  typeof value === "string" ? codeValue(value) : codeValue(JSON.stringify(value));

const exampleValues = (values: unknown): string =>
  !Array.isArray(values) || values.length === 0 ? "—" : values.map(exampleValue).join(", ");

const examples = (property: AST.PropertySignature): string =>
  exampleValues(property.type.context?.annotations?.examples ?? AST.resolveAt("examples")(property.type));

const defaultValues = (
  jsonSchemas: ReadonlyArray<JsonObject | undefined>,
  jsonSchemaRoot: JsonObject,
): string => {
  const values = uniqueValues(
    jsonSchemas.flatMap((jsonSchema) => {
      const resolved =
        jsonSchema === undefined
          ? undefined
          : (resolveLocalSchemaRef(jsonSchema, jsonSchemaRoot) ?? jsonSchema);
      return Object.hasOwn(resolved ?? {}, "default") ? [formattedJsonValue(resolved?.default)] : [];
    }),
  );
  return values.length > 0 ? values.map(codeValue).join(", ") : "—";
};

const schemaExamples = (ast: AST.AST): string => exampleValues(AST.resolveAt("examples")(ast));

const schemaAcceptedValues = (ast: AST.AST, jsonSchema: JsonObject): string => {
  const values = jsonSchemaAcceptedValues(jsonSchema, jsonSchema);
  const fallbackValues = values.length > 0 ? values : literalValues(ast);
  return fallbackValues.length > 0 ? fallbackValues.map(codeValue).join(", ") : "—";
};

type SchemaReferenceField = {
  readonly name: string;
  readonly required: boolean;
  readonly property?: AST.PropertySignature;
  readonly jsonSchemas: ReadonlyArray<JsonObject | undefined>;
  readonly jsonSchemaRoot: JsonObject;
};

const isRequiredJsonSchemaProperty = (jsonSchema: JsonObject, name: string): boolean =>
  Array.isArray(jsonSchema.required) && jsonSchema.required.includes(name);

const typeLiteralFields = (ast: AST.Objects, jsonSchema: JsonObject): ReadonlyArray<SchemaReferenceField> => {
  const properties = jsonObject(jsonSchema.properties);
  return ast.propertySignatures.flatMap((property) => {
    if (typeof property.name !== "string") return [];
    return [
      {
        name: property.name,
        required: isRequiredJsonSchemaProperty(jsonSchema, property.name),
        property: new AST.PropertySignature(property.name, AST.toEncoded(property.type)),
        jsonSchemas: [properties === undefined ? undefined : jsonObject(properties[property.name])],
        jsonSchemaRoot: jsonSchema,
      },
    ];
  });
};

const unionTypeLiterals = (ast: AST.AST): ReadonlyArray<AST.Objects> => {
  const referenceAst = schemaReferenceAst(ast);
  if (AST.isObjects(referenceAst)) return [referenceAst];
  if (!AST.isUnion(referenceAst)) return [];
  return referenceAst.types.flatMap((member) => {
    const memberAst = schemaReferenceAst(member);
    return AST.isObjects(memberAst) ? [memberAst] : [];
  });
};

const objectUnionFields = (ast: AST.AST, jsonSchema: JsonObject): ReadonlyArray<SchemaReferenceField> => {
  const propertiesByName = new Map<string, AST.PropertySignature>();
  for (const typeLiteral of unionTypeLiterals(ast)) {
    for (const property of typeLiteral.propertySignatures) {
      if (typeof property.name === "string" && !propertiesByName.has(property.name)) {
        propertiesByName.set(property.name, property);
      }
    }
  }

  const objectBranches = unionBranches(jsonSchema, jsonSchema).filter((branch) => branch.type === "object");
  const fields = new Map<
    string,
    { appearances: number; requiredInPresentBranches: boolean; jsonSchemas: Array<JsonObject | undefined> }
  >();
  for (const branch of objectBranches) {
    const properties = jsonObject(branch.properties);
    if (properties === undefined) continue;
    for (const name of Object.keys(properties)) {
      const branchRequiresField = isRequiredJsonSchemaProperty(branch, name);
      const existing = fields.get(name) ?? {
        appearances: 0,
        requiredInPresentBranches: true,
        jsonSchemas: [],
      };
      existing.appearances += 1;
      existing.requiredInPresentBranches = existing.requiredInPresentBranches && branchRequiresField;
      existing.jsonSchemas.push(jsonObject(properties[name]));
      fields.set(name, existing);
    }
  }
  return [...fields.entries()].map(([name, field]) => {
    const property = propertiesByName.get(name);
    return {
      name,
      required: field.appearances === objectBranches.length && field.requiredInPresentBranches,
      ...(property === undefined ? {} : { property }),
      jsonSchemas: field.jsonSchemas,
      jsonSchemaRoot: jsonSchema,
    };
  });
};

const renderFieldRows = (fields: ReadonlyArray<SchemaReferenceField>): ReadonlyArray<string> => {
  const rows: string[] = [
    "| Field | Required | Type | Description | Default | Accepted values | Examples | Deprecation |",
    "| --- | --- | --- | --- | --- | --- | --- | --- |",
  ];
  for (const field of fields) {
    const propertyNotice =
      field.property === undefined
        ? undefined
        : (getSchemaDeprecation(field.property) ?? findSchemaReferenceDeprecation(field.property.type));
    rows.push(
      [
        codeValue(field.name),
        field.required ? "Yes" : "No",
        fieldType(field.property, field.jsonSchemas, field.jsonSchemaRoot),
        field.property === undefined ? "—" : markdownTextCell(fieldDescription(field.property) ?? "—"),
        defaultValues(field.jsonSchemas, field.jsonSchemaRoot),
        acceptedValues(field.property, field.jsonSchemas, field.jsonSchemaRoot),
        field.property === undefined ? "—" : examples(field.property),
        propertyNotice === undefined ? "—" : markdownTextCell(formatDeprecationNotice(propertyNotice)),
      ]
        .map(markdownCell)
        .join(" | ")
        .replace(/^/, "| ")
        .replace(/$/, " |"),
    );
  }
  return rows;
};

const indexSignatureKeyType = (signature: AST.IndexSignature): string => {
  switch (signature.parameter._tag) {
    case "String":
    case "Symbol":
      return signature.parameter.checks === undefined ? "`string`" : "patterned `string`";
    case "TemplateLiteral":
      return "patterned `string`";
    default:
      return "—";
  }
};

const renderIndexSignatureRows = (ast: AST.Objects, jsonSchema: JsonObject): ReadonlyArray<string> => {
  if (ast.indexSignatures.length === 0) return [];
  const rows = ["| Keys | Values |", "| --- | --- |"];
  for (const signature of ast.indexSignatures) {
    const indexSchema = jsonObject(indexSignatureJsonSchema(jsonSchema, signature));
    const jsonTypes = jsonSchemaTypes(indexSchema, jsonSchema);
    const valueType =
      jsonTypes.length > 0
        ? jsonTypes.map(codeValue).join(", ")
        : astDisplayType(signature.type, { showUnknown: true });
    rows.push(`| ${indexSignatureKeyType(signature)} | ${valueType} |`);
  }
  return rows;
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
    `# ${mdxText(title)}`,
    "",
  ];
  if (description !== undefined) lines.push(mdxText(description), "");
  if (jsonSchemaPath !== undefined) {
    lines.push(`[JSON Schema artifact](../../../${jsonSchemaPath})`, "");
  }

  const notice = getSchemaDeprecation(schema.ast);
  if (notice !== undefined) lines.push("> [!WARNING]", `> ${mdxText(formatDeprecationNotice(notice))}`, "");

  const jsonSchema =
    options.jsonSchema === undefined
      ? schemaReferenceJsonObject(schema)
      : resolveRootJsonSchemaRef(options.jsonSchema);
  const ast = schemaReferenceAst(schema.ast);
  const fields = AST.isObjects(ast) ? typeLiteralFields(ast, jsonSchema) : objectUnionFields(ast, jsonSchema);
  if (fields.length > 0 || AST.isObjects(ast)) {
    lines.push(...renderFieldRows(fields), "");
  }

  if (AST.isObjects(ast) && ast.indexSignatures.length > 0) {
    lines.push("## Schema details", "", ...renderIndexSignatureRows(ast, jsonSchema), "");
  }

  const schemaTypes = jsonSchemaTypes(jsonSchema, jsonSchema);
  const hasNonObjectRootBranch = schemaTypes.some((type) => type !== "object");
  if (!AST.isObjects(ast) && (fields.length === 0 || hasNonObjectRootBranch)) {
    const rows = [
      "| Type | Default | Accepted values | Examples |",
      "| --- | --- | --- | --- |",
      [
        schemaTypes.length > 0 ? schemaTypes.map(codeValue).join(", ") : "—",
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
