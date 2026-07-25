export interface ComposeCoverageDiff {
  readonly missingFromMatrix: ReadonlyArray<string>;
  readonly missingFromSchema: ReadonlyArray<string>;
}

type JsonObject = Record<string, unknown>;

export class ComposeSchemaError extends Error {
  readonly reason: string;

  constructor(reason: string) {
    super(`Invalid Compose schema: ${reason}`);
    this.name = "ComposeSchemaError";
    this.reason = reason;
  }
}

const isJsonObject = (value: unknown): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const requireObject = (value: unknown, reason: string): JsonObject => {
  if (!isJsonObject(value)) throw new ComposeSchemaError(reason);
  return value;
};

const resolveLocalRef = (document: unknown, ref: string): unknown => {
  if (!ref.startsWith("#/")) {
    throw new ComposeSchemaError(`only local references are supported, received ${ref}`);
  }

  let current = document;
  for (const encodedSegment of ref.slice(2).split("/")) {
    const segment = encodedSegment.replaceAll("~1", "/").replaceAll("~0", "~");
    const object = requireObject(current, `reference ${ref} traverses a non-object at ${segment}`);
    if (!(segment in object)) throw new ComposeSchemaError(`reference ${ref} does not resolve`);
    current = object[segment];
  }
  return current;
};

const patternSegment = (pattern: string): string => (pattern.startsWith("^x-") ? "x-*" : "*");

const addPath = (paths: Set<string>, path: ReadonlyArray<string>): void => {
  if (path.length > 0) paths.add(path.join("."));
};

const walkSchema = (
  document: unknown,
  value: unknown,
  prefix: ReadonlyArray<string>,
  paths: Set<string>,
  activeRefs: ReadonlySet<string>,
): void => {
  if (typeof value === "boolean") return;
  const schema = requireObject(value, `schema at ${prefix.join(".") || "<root>"} is not an object`);

  const ref = schema.$ref;
  if (typeof ref === "string" && !activeRefs.has(ref)) {
    walkSchema(document, resolveLocalRef(document, ref), prefix, paths, new Set([...activeRefs, ref]));
  }

  const properties = schema.properties;
  if (properties !== undefined) {
    for (const [key, child] of Object.entries(requireObject(properties, "properties must be an object")).sort(
      ([left], [right]) => left.localeCompare(right),
    )) {
      const path = [...prefix, key];
      addPath(paths, path);
      walkSchema(document, child, path, paths, activeRefs);
    }
  }

  const patternProperties = schema.patternProperties;
  if (patternProperties !== undefined) {
    for (const [pattern, child] of Object.entries(
      requireObject(patternProperties, "patternProperties must be an object"),
    ).sort(([left], [right]) => left.localeCompare(right))) {
      const path = [...prefix, patternSegment(pattern)];
      addPath(paths, path);
      walkSchema(document, child, path, paths, activeRefs);
    }
  }

  const additionalProperties = schema.additionalProperties;
  if (additionalProperties === true || isJsonObject(additionalProperties)) {
    const path = [...prefix, "*"];
    addPath(paths, path);
    if (isJsonObject(additionalProperties)) {
      walkSchema(document, additionalProperties, path, paths, activeRefs);
    }
  }

  const items = schema.items;
  if (Array.isArray(items)) {
    for (const item of items) walkSchema(document, item, prefix, paths, activeRefs);
  } else if (items !== undefined) {
    walkSchema(document, items, prefix, paths, activeRefs);
  }

  const prefixItems = schema.prefixItems;
  if (Array.isArray(prefixItems)) {
    for (const item of prefixItems) walkSchema(document, item, prefix, paths, activeRefs);
  }

  for (const keyword of ["allOf", "anyOf", "oneOf"] as const) {
    const variants = schema[keyword];
    if (variants === undefined) continue;
    if (!Array.isArray(variants)) throw new ComposeSchemaError(`${keyword} must be an array`);
    for (const variant of variants) walkSchema(document, variant, prefix, paths, activeRefs);
  }

  for (const keyword of ["if", "then", "else", "not", "contains"] as const) {
    const child = schema[keyword];
    if (child !== undefined) walkSchema(document, child, prefix, paths, activeRefs);
  }
};

const sorted = (values: Iterable<string>): ReadonlyArray<string> => [...new Set(values)].sort();

export const collectComposeServiceKeyPaths = (schema: unknown): ReadonlyArray<string> => {
  const root = requireObject(schema, "root must be an object");
  const properties = requireObject(root.properties, "root properties must be an object");
  const services = requireObject(properties.services, "properties.services must be an object");
  const entrySchemas: Array<unknown> = [];

  if (services.patternProperties !== undefined) {
    entrySchemas.push(
      ...Object.values(
        requireObject(services.patternProperties, "services.patternProperties must be an object"),
      ),
    );
  }
  if (isJsonObject(services.additionalProperties)) entrySchemas.push(services.additionalProperties);
  if (entrySchemas.length === 0) throw new ComposeSchemaError("services declares no service entry schema");

  const paths = new Set<string>();
  for (const entrySchema of entrySchemas) walkSchema(schema, entrySchema, [], paths, new Set());
  return sorted(paths);
};

export const collectComposeTopLevelKeyPaths = (schema: unknown): ReadonlyArray<string> => {
  const root = requireObject(schema, "root must be an object");
  const paths = new Set<string>();
  const properties = requireObject(root.properties, "root properties must be an object");
  for (const key of Object.keys(properties)) paths.add(key);

  if (root.patternProperties !== undefined) {
    for (const pattern of Object.keys(
      requireObject(root.patternProperties, "root patternProperties must be an object"),
    )) {
      paths.add(patternSegment(pattern));
    }
  }

  return sorted(paths);
};

export const compareComposeCoverage = (
  schemaPaths: ReadonlyArray<string>,
  matrixPaths: ReadonlyArray<string>,
): ComposeCoverageDiff => {
  const schema = new Set(schemaPaths);
  const matrix = new Set(matrixPaths);
  return {
    missingFromMatrix: sorted(schemaPaths.filter((path) => !matrix.has(path))),
    missingFromSchema: sorted(matrixPaths.filter((path) => !schema.has(path))),
  };
};

export interface ComposeSchemaDiff {
  readonly addedServicePaths: ReadonlyArray<string>;
  readonly removedServicePaths: ReadonlyArray<string>;
  readonly addedTopLevelPaths: ReadonlyArray<string>;
  readonly removedTopLevelPaths: ReadonlyArray<string>;
}

const missing = (from: ReadonlyArray<string>, present: ReadonlyArray<string>): ReadonlyArray<string> => {
  const set = new Set(present);
  return sorted(from.filter((path) => !set.has(path)));
};

export const diffComposeSchemaKeyPaths = (oldSchema: unknown, newSchema: unknown): ComposeSchemaDiff => {
  const oldService = collectComposeServiceKeyPaths(oldSchema);
  const newService = collectComposeServiceKeyPaths(newSchema);
  const oldTopLevel = collectComposeTopLevelKeyPaths(oldSchema);
  const newTopLevel = collectComposeTopLevelKeyPaths(newSchema);
  return {
    addedServicePaths: missing(newService, oldService),
    removedServicePaths: missing(oldService, newService),
    addedTopLevelPaths: missing(newTopLevel, oldTopLevel),
    removedTopLevelPaths: missing(oldTopLevel, newTopLevel),
  };
};

const markdownSection = (heading: string, paths: ReadonlyArray<string>): string =>
  paths.length === 0
    ? `### ${heading}\n\n_None_\n`
    : `### ${heading}\n\n${paths.map((path) => `- \`${path}\``).join("\n")}\n`;

export const formatComposeSchemaDiffMarkdown = (diff: ComposeSchemaDiff): string => {
  const unchanged =
    diff.addedServicePaths.length === 0 &&
    diff.removedServicePaths.length === 0 &&
    diff.addedTopLevelPaths.length === 0 &&
    diff.removedTopLevelPaths.length === 0;
  if (unchanged) return "## Compose schema key path changes\n\nNo key path changes.\n";

  return [
    "## Compose schema key path changes\n",
    markdownSection("Added service key paths", diff.addedServicePaths),
    markdownSection("Removed service key paths", diff.removedServicePaths),
    markdownSection("Added top-level key paths", diff.addedTopLevelPaths),
    markdownSection("Removed top-level key paths", diff.removedTopLevelPaths),
  ].join("\n");
};
