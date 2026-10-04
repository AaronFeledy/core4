import { SchemaAST as AST, Schema, SchemaTransformation } from "effect";
import { decodeUnknownEffect, encodeUnknownEffect } from "effect/SchemaParser";

const JSON_PROJECTION = "lando/authoring/json-projection";

const isStructuralCheck = (check: AST.Check<unknown>): boolean =>
  check.annotations?.["~structural"] === true ||
  (check._tag === "FilterGroup" && check.checks.every(isStructuralCheck));

const structuralChecks = (checks: AST.Checks | undefined): AST.Checks | undefined => {
  if (checks === undefined) return undefined;
  const kept = checks.filter(isStructuralCheck);
  const [first, ...rest] = kept;
  return first === undefined ? undefined : [first, ...rest];
};

const droppedWireAnnotations = ["jsonSchemaProjection", "acceptsImportRef"] as const;

const withoutJsonSchemaProjection = (annotations: AST.AST["annotations"]): AST.AST["annotations"] => {
  if (annotations === undefined || !droppedWireAnnotations.some((key) => annotations[key] !== undefined)) {
    return annotations;
  }
  const rest = { ...annotations };
  for (const key of droppedWireAnnotations) delete rest[key];
  return rest;
};

const mapComposite = (
  node: AST.AST,
  go: (node: AST.AST) => AST.AST,
  parameters: "keep" | "walk",
): AST.AST => {
  const annotations =
    parameters === "keep" ? withoutJsonSchemaProjection(node.annotations) : node.annotations;
  const checks = parameters === "keep" ? structuralChecks(node.checks) : node.checks;
  const changed = annotations !== node.annotations || checks !== node.checks;
  const metadata = [annotations, checks, node.encoding, node.context] as const;
  switch (node._tag) {
    case "Objects":
      return new AST.Objects(
        node.propertySignatures.map((property) => {
          const type = go(property.type);
          return type === property.type ? property : new AST.PropertySignature(property.name, type);
        }),
        node.indexSignatures.map((index) => {
          const parameter = parameters === "keep" ? index.parameter : go(index.parameter);
          const type = go(index.type);
          return parameter === index.parameter && type === index.type
            ? index
            : new AST.IndexSignature(parameter, type);
        }),
        ...metadata,
        changed ? undefined : node.encodingChecks,
      );
    case "Arrays":
      return new AST.Arrays(
        node.isMutable,
        node.elements.map(go),
        node.rest.map(go),
        ...metadata,
        changed ? undefined : node.encodingChecks,
      );
    case "Union":
      return new AST.Union(
        node.types.map(go),
        node.options,
        ...metadata,
        changed ? undefined : node.encodingChecks,
      );
    case "Declaration":
      return new AST.Declaration(
        node.typeParameters.map(go),
        node.run,
        ...metadata,
        changed ? undefined : node.encodingChecks,
        node.encodingRun,
      );
  }
  if (!changed) return node;
  switch (node._tag) {
    case "Null":
      return new AST.Null(...metadata);
    case "Undefined":
      return new AST.Undefined(...metadata);
    case "Void":
      return new AST.Void(...metadata);
    case "Never":
      return new AST.Never(...metadata);
    case "Unknown":
      return new AST.Unknown(...metadata);
    case "Any":
      return new AST.Any(...metadata);
    case "String":
      return new AST.String(...metadata);
    case "Number":
      return new AST.Number(...metadata);
    case "Boolean":
      return new AST.Boolean(...metadata);
    case "BigInt":
      return new AST.BigInt(...metadata);
    case "Symbol":
      return new AST.Symbol(...metadata);
    case "ObjectKeyword":
      return new AST.ObjectKeyword(...metadata);
    case "Enum":
      return new AST.Enum(node.enums, ...metadata);
    case "Literal":
      return new AST.Literal(node.literal, ...metadata);
    case "UniqueSymbol":
      return new AST.UniqueSymbol(node.symbol, ...metadata);
    case "TemplateLiteral":
      return new AST.TemplateLiteral(node.parts, ...metadata);
    case "Suspend":
      return new AST.Suspend(node.thunk, ...metadata);
    default:
      return node satisfies never;
  }
};

const memoWalk = (visit: (node: AST.AST, go: (node: AST.AST) => AST.AST) => AST.AST) => {
  const memo = new WeakMap<AST.AST, AST.AST>();
  const go = (node: AST.AST): AST.AST => {
    const cached = memo.get(node);
    if (cached !== undefined) return cached;
    if (node._tag === "Suspend") {
      const suspended = new AST.Suspend(
        () => go(node.thunk()),
        node.annotations,
        undefined,
        undefined,
        node.context,
      );
      memo.set(node, suspended);
      return suspended;
    }
    const walked = visit(node, go);
    memo.set(node, walked);
    return walked;
  };
  return go;
};

/** Checked-container JSON projection. Runtime parsing stays on `runtime`. */
const checkProjectsObjectSchema = (check: AST.Check<unknown>): boolean => {
  if (check._tag === "FilterGroup") return check.checks.some(checkProjectsObjectSchema);
  const callback = check.annotations?.toJsonSchema;
  if (typeof callback !== "function") return false;
  const output = callback({ type: "object", schemas: [] });
  const schema = Array.isArray(output) ? output[0] : output;
  return typeof schema === "object" && schema !== null && "properties" in schema;
};

export const authoringJsonContainer = (source: AST.AST, runtime: AST.AST): AST.AST | undefined => {
  if (source.checks === undefined || !source.checks.some(checkProjectsObjectSchema)) return undefined;
  const projection =
    source._tag === "Objects"
      ? new AST.Objects(
          source.propertySignatures.map(
            (property) => new AST.PropertySignature(property.name, property.type),
          ),
          source.indexSignatures.map((index) => new AST.IndexSignature(index.parameter, index.type)),
          source.annotations,
        )
      : source._tag === "Arrays"
        ? new AST.Arrays(source.isMutable, [...source.elements], [...source.rest], source.annotations)
        : undefined;
  if (projection === undefined) return undefined;
  const schema = Schema.make<Schema.Codec<unknown>>(runtime);
  const decode = decodeUnknownEffect(schema);
  const encode = encodeUnknownEffect(schema);
  return new AST.Declaration(
    [runtime],
    () => (input, _self, options) => decode(input, options),
    {
      [JSON_PROJECTION]: true,
      toCodecJson: () =>
        new AST.Link(
          projection,
          SchemaTransformation.transform({
            decode: (value: unknown) => value,
            encode: (value: unknown) => value,
          }),
        ),
    },
    undefined,
    undefined,
    undefined,
    undefined,
    () => (input, _self, options) => encode(input, options),
  );
};

/** Structural encoded tree. Refinement checks stay on the validated authoring schema. */
export const authoringWireAst = (ast: AST.AST): AST.AST => {
  const unwrap = memoWalk((node, go) => {
    if (node._tag === "Declaration" && node.annotations?.[JSON_PROJECTION] === true) {
      const runtime = node.typeParameters[0];
      return runtime === undefined ? node : go(runtime);
    }
    return mapComposite(node, go, "walk");
  });
  const strip = memoWalk((node, go) => mapComposite(node, go, "keep"));
  return strip(AST.toEncoded(unwrap(ast)));
};
