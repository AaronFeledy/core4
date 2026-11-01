import { Result, Schema, SchemaAST } from "effect";

type Mutation = {
  readonly id: number;
  readonly path: readonly (string | number)[];
  readonly value: unknown;
  readonly partial: boolean;
  readonly discriminator?: boolean;
  readonly tagged?: boolean;
  readonly transformed?: boolean;
};
type Branch = { readonly witness: unknown; readonly mutations: readonly Mutation[] };
const options = { errors: "all", onExcessProperty: "error" } as const;
const wrong = [null, 5, false, "invalid-value", [], { unexpectedDiagnosticKey: true }];
// Reviewed candidates for arbitrary checks (paths, semver, durations, commands,
// build blocks and bounded numbers). Every selected witness is decoded below.
const reviewed = [
  "web",
  "demo",
  "/app",
  "./app",
  "1s",
  "1.0.0",
  "echo ok",
  "KEY=value",
  `sha256:${"a".repeat(64)}`,
  "https://example.com",
  "*",
  "8080:80",
  "every_1h",
  "true",
  "127.0.0.1",
  0,
  1,
  80,
  200,
  ["web"],
  {},
  { cmd: "echo ok" },
  { dockerfile: "Dockerfile" },
];
const missingRequired = (ast: SchemaAST.AST, value: unknown): boolean => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  if (ast._tag === "Union") return ast.types.some((member) => missingRequired(member, value));
  return (
    ast._tag === "Objects" &&
    ast.propertySignatures.some(
      (field) => field.type.context?.isOptional !== true && !Object.hasOwn(value, field.name),
    )
  );
};

export const diagnosticCorpus = (root: SchemaAST.AST) => {
  const cache = new Map<SchemaAST.AST, readonly Branch[]>();
  const identifiers = new Set<string>();
  const inventory = new Map<string, number>();
  const uncovered = new Set<string>();
  let nextId = 0;
  const accepts = (ast: SchemaAST.AST, value: unknown) =>
    Result.isSuccess(Schema.decodeUnknownResult(Schema.make<Schema.Codec<unknown>>(ast))(value, options));
  const walk = (original: SchemaAST.AST, depth: number): readonly Branch[] => {
    const cached = cache.get(original);
    if (cached !== undefined) return cached;
    const id = original.annotations?.identifier;
    if (typeof id === "string") identifiers.add(id);
    if (depth > 18) return [];
    cache.set(original, []); // Bound cycles before following encodings/suspensions.
    const ast = original.encoding === undefined ? original : SchemaAST.toEncoded(original);
    const encodedId = ast.annotations?.identifier;
    if (typeof encodedId === "string") identifiers.add(encodedId);
    inventory.set(ast._tag, (inventory.get(ast._tag) ?? 0) + 1);
    let branches: readonly Branch[] = [];
    switch (ast._tag) {
      case "Union": {
        const tags = new Set(
          ast.types.flatMap((member) =>
            member._tag === "Objects"
              ? member.propertySignatures
                  .filter(
                    (field) =>
                      field.type.context?.isOptional !== true &&
                      (field.type._tag === "Literal" ||
                        (field.type._tag === "Union" &&
                          field.type.types.every((child) => child._tag === "Literal"))),
                  )
                  .map((field) => field.name)
              : [],
          ),
        );
        branches = ast.types
          .flatMap((member) => walk(member, depth + 1))
          .map((branch) => ({
            ...branch,
            mutations: branch.mutations.map((mutation) => ({
              ...mutation,
              partial:
                mutation.partial || (mutation.path.length === 0 && missingRequired(ast, mutation.value)),
              ...(tags.size === 0 ? {} : { tagged: true }),
              ...(mutation.path.length === 1 && tags.has(String(mutation.path[0]))
                ? { discriminator: true }
                : {}),
            })),
          }));
        break;
      }
      case "Suspend":
        branches = walk(ast.thunk(), depth + 1);
        break;
      case "Objects": {
        const fields = ast.propertySignatures.flatMap((field) =>
          typeof field.name === "string"
            ? [
                {
                  key: field.name,
                  branches: walk(field.type, depth + 1),
                  required: !field.type.context?.isOptional,
                },
              ]
            : [],
        );
        const witness: Record<string, unknown> =
          id === "DeprecationNotice"
            ? { since: "4.2.0", removeIn: "5.0.0", note: "Use the replacement." }
            : {};
        for (const field of fields) {
          if (field.required && field.branches[0] !== undefined && !Object.hasOwn(witness, field.key))
            witness[field.key] = field.branches[0].witness;
        }
        const mutations: Mutation[] = [];
        for (const field of fields) {
          for (const branch of field.branches) {
            const candidate = { ...witness, [field.key]: branch.witness };
            const base = accepts(ast, candidate) ? candidate : witness;
            if (!Object.hasOwn(base, field.key)) continue;
            if (!accepts(ast, base)) continue;
            mutations.push(
              ...branch.mutations.map((mutation) => ({
                ...mutation,
                path: [field.key, ...mutation.path],
                value: { ...base, [field.key]: mutation.value },
              })),
            );
          }
        }
        for (const index of ast.indexSignatures) {
          const key = walk(index.parameter, depth + 1)[0]?.witness;
          if (typeof key !== "string") continue;
          for (const branch of walk(index.type, depth + 1)) {
            const base = { ...witness, [key]: branch.witness };
            if (!accepts(ast, base)) continue;
            mutations.push(
              ...branch.mutations.map((mutation) => ({
                ...mutation,
                path: [key, ...mutation.path],
                value: { ...base, [key]: mutation.value },
              })),
            );
          }
        }
        const unknown = {
          ...witness,
          [fields.some((field) => field.key === "image") ? "imgae" : "unexpectedDiagnosticKey"]: true,
        };
        if (accepts(ast, witness) && !accepts(ast, unknown))
          mutations.push({ id: nextId++, path: [], value: unknown, partial: false });
        branches = [{ witness, mutations }];
        break;
      }
      case "Arrays": {
        const members = [...ast.elements, ...ast.rest];
        const witness = ast.elements.map((member) => walk(member, depth + 1)[0]?.witness);
        const mutations = members.flatMap((member, index) =>
          walk(member, depth + 1).flatMap((branch) => {
            const base = [...witness];
            base[index] = branch.witness;
            if (!accepts(ast, base)) return [];
            return branch.mutations.map((mutation) => {
              const value = [...base];
              value[index] = mutation.value;
              return { ...mutation, path: [index, ...mutation.path], value };
            });
          }),
        );
        branches = [{ witness, mutations }];
        break;
      }
      case "Declaration":
        branches = ast.typeParameters.flatMap((member) => walk(member, depth + 1));
        break;
      case "Literal":
        branches = [{ witness: ast.literal, mutations: [] }];
        break;
      case "Enum":
        branches = ast.enums.map((entry) => ({ witness: entry[1], mutations: [] }));
        break;
      case "Null":
        branches = [{ witness: null, mutations: [] }];
        break;
      case "Undefined":
      case "Void":
        branches = [{ witness: undefined, mutations: [] }];
        break;
      case "Never":
        break;
      case "String":
      case "TemplateLiteral":
      case "Number":
      case "Boolean":
      case "BigInt":
      case "Symbol":
      case "UniqueSymbol":
      case "ObjectKeyword":
      case "Any":
      case "Unknown":
        break;
      default:
        return ast satisfies never;
    }
    const valid = branches.filter((branch) => accepts(ast, branch.witness));
    if (valid.length === 0) {
      const witness = [...reviewed, true, null, [], "x-example", "8080:80", "10M"].find((value) =>
        accepts(ast, value),
      );
      if (witness !== undefined) valid.push({ witness, mutations: [] });
      else if (ast._tag !== "Never")
        uncovered.add(
          JSON.stringify({
            id: id ?? ast._tag,
            description: ast.annotations?.description,
            checks: ast.checks?.map((check) => check.annotations),
          }),
        );
    }
    const result = valid.map((branch) => ({
      ...branch,
      mutations: [
        ...wrong
          .filter((value) => !accepts(ast, value))
          .map((value) => ({ id: nextId++, path: [], value, partial: missingRequired(ast, value) })),
        ...branch.mutations.map((mutation) =>
          original.encoding === undefined ? mutation : { ...mutation, transformed: true },
        ),
      ],
    }));
    cache.set(original, result);
    return result;
  };
  const branches = walk(root, 0);
  const unique = new Map<number, Mutation>();
  for (const branch of branches)
    for (const mutation of branch.mutations) if (!unique.has(mutation.id)) unique.set(mutation.id, mutation);
  return { cases: [...unique.values()], identifiers, inventory, uncovered };
};
