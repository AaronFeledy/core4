import { expect, test } from "bun:test";
import { LandofileAuthoringFragmentNative, LandofileShape, schemaIssueLeaves } from "@lando/sdk/schema";
import { Result, Schema, type SchemaAST } from "effect";
import { landofileIssuesFromSchema } from "../src/validation-suggestions.ts";
import { diagnosticCorpus } from "./diagnostic-corpus.ts";

const schemaIdentifiers = (root: SchemaAST.AST): readonly string[] => {
  const seen = new Set<SchemaAST.AST>();
  const ids = new Set<string>();
  const visit = (ast: SchemaAST.AST): void => {
    if (seen.has(ast)) return;
    seen.add(ast);
    if (typeof ast.annotations?.identifier === "string") ids.add(ast.annotations.identifier);
    if (ast.encoding !== undefined) for (const link of ast.encoding) visit(link.to);
    switch (ast._tag) {
      case "Objects":
        for (const field of ast.propertySignatures) visit(field.type);
        for (const index of ast.indexSignatures) {
          visit(index.parameter);
          visit(index.type);
        }
        break;
      case "Arrays":
        for (const child of [...ast.elements, ...ast.rest]) visit(child);
        break;
      case "Union":
        for (const child of ast.types) visit(child);
        break;
      case "Declaration":
        for (const child of ast.typeParameters) visit(child);
        break;
      case "Suspend":
        visit(ast.thunk());
        break;
      default:
        break;
    }
  };
  visit(root);
  return [...ids];
};

const options = { errors: "all", onExcessProperty: "error" } as const;
const corpus = diagnosticCorpus(LandofileShape.ast);
// Include derived identifiers in the blacklist, without generating authoring mutations.
const identifiers = new Set([
  ...schemaIdentifiers(LandofileShape.ast),
  ...schemaIdentifiers(LandofileAuthoringFragmentNative.ast),
]);
const issues = (schema: Schema.ConstraintDecoder<unknown, never>, input: unknown) => {
  const result = Schema.decodeUnknownResult(schema)(input, options);
  return Result.isFailure(result)
    ? {
        diagnostics: landofileIssuesFromSchema(result.failure.issue, input),
        missing: schemaIssueLeaves(result.failure.issue).some((leaf) => leaf._tag === "Missing"),
      }
    : { diagnostics: [], missing: false };
};

test("generated Landofile defects have plain messages and unchanged-scope parity", () => {
  // Given one-site mutations in valid witnesses, not a Cartesian product.
  expect(corpus.cases.length).toBeGreaterThan(3000);
  expect(corpus.uncovered.size).toBe(0);
  expect(Object.fromEntries(corpus.inventory)).toMatchObject({
    Objects: expect.any(Number),
    Union: expect.any(Number),
    Arrays: expect.any(Number),
    Declaration: expect.any(Number),
  });
  for (const count of corpus.inventory.values()) expect(count).toBeGreaterThan(0);
  console.log(
    "Landofile diagnostic corpus",
    corpus.cases.length,
    Object.fromEntries(corpus.inventory),
    "uncovered witnesses",
    [...corpus.uncovered],
  );
  const failures: unknown[] = [];
  const exceptions = new Map<string, number>();
  let compared = 0;
  let tagged = 0;
  let accepted = 0;
  let suggested = 0;
  // When
  for (const sample of corpus.cases) {
    const effectiveResult = issues(LandofileShape, sample.value);
    const fragmentResult = issues(LandofileAuthoringFragmentNative, sample.value);
    const effective = effectiveResult.diagnostics;
    const fragment = fragmentResult.diagnostics;
    for (const issue of [...effective, ...fragment]) {
      if (
        issue.message.includes("Symbol(") ||
        issue.message.includes("Authoring") ||
        issue.message.includes("authoring site: Expected an expression, not plain text") ||
        [...identifiers].some((id) => issue.message.includes(id))
      ) {
        failures.push({ path: sample.path, issue });
      }
    }
    // Exceptions: partial fragments omit required keys (including object-shaped
    // wrong values); dependsOn normalizes map/list spellings at an encoding boundary.
    // Type-side transform constraints do not run on authored inputs. No expressions are
    // generated here; their intentional asymmetry is covered by SDK slot tests.
    if (effective.length === 0 && fragment.length === 0) {
      accepted++;
      continue;
    }
    const exception =
      sample.partial || effectiveResult.missing
        ? "partial missing keys"
        : sample.path[0] === "services" && sample.path[2] === "dependsOn"
            ? "dependsOn input transform"
            : sample.transformed === true && (effective.length === 0 || fragment.length === 0)
              ? "transform-only constraint"
              : undefined;
    if (exception !== undefined) exceptions.set(exception, (exceptions.get(exception) ?? 0) + 1);
    else {
      compared++;
      if (sample.tagged === true) tagged++;
      if (effective.some((issue) => issue.suggestion !== undefined)) suggested++;
    }
    if (
      exception === undefined &&
      JSON.stringify(effective) !== JSON.stringify(fragment)
    ) {
      failures.push({ path: sample.path, value: sample.value, effective, fragment });
    }
  }
  // Then
  console.log("Parity coverage", { compared, tagged, accepted, suggested, exceptions: Object.fromEntries(exceptions) });
  expect(compared).toBeGreaterThan(2500);
  expect(tagged).toBeGreaterThan(100);
  expect(suggested).toBeGreaterThan(0);
  expect([...exceptions.keys()].sort()).toEqual([
    "dependsOn input transform",
    "partial missing keys",
    "transform-only constraint",
  ]);
  expect(failures.slice(0, 12)).toEqual([]);
});
