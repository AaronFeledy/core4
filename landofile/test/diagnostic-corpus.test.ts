import { expect, test } from "bun:test";
import { LandofileAuthoringFragmentNative, LandofileShape } from "@lando/sdk/schema";
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
  return Result.isFailure(result) ? landofileIssuesFromSchema(result.failure.issue, input) : [];
};

test("generated Landofile defects have plain messages and unchanged-scope parity", () => {
  // Given one-site mutations in valid witnesses, not a Cartesian product.
  expect(corpus.cases.length).toBeGreaterThan(0);
  expect(corpus.uncovered.size).toBe(0);
  expect(Object.fromEntries(corpus.inventory)).toMatchObject({
    Objects: expect.any(Number),
    Union: expect.any(Number),
    Arrays: expect.any(Number),
    Declaration: expect.any(Number),
  });
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
  // When
  for (const sample of corpus.cases) {
    const effective = issues(LandofileShape, sample.value);
    const fragment = issues(LandofileAuthoringFragmentNative, sample.value);
    for (const issue of [...effective, ...fragment]) {
      if (
        issue.message.includes("Symbol(") ||
        issue.message.includes("authoring site: Expected an expression, not plain text") ||
        [...identifiers].some((id) => issue.message.includes(id))
      ) {
        failures.push({ path: sample.path, issue });
      }
    }
    // Exceptions: partial fragments omit required keys (including object-shaped
    // wrong values); unmatched discriminators have no selected member; dependsOn
    // normalizes map/list spellings at an encoding boundary. No expressions are
    // generated here; their intentional asymmetry is covered by SDK slot tests.
    const unchanged = (list: typeof effective) => list.filter((issue) => issue.message !== "Missing key");
    const exception =
      sample.partial || effective.some((issue) => issue.message === "Missing key")
        ? "partial missing keys"
        : sample.discriminator === true
          ? "unmatched discriminator"
          : sample.path[0] === "services" && sample.path[2] === "dependsOn"
            ? "dependsOn input transform"
            : sample.transformed === true && (effective.length === 0 || fragment.length === 0)
              ? "transform-only constraint"
              : undefined;
    if (exception !== undefined) exceptions.set(exception, (exceptions.get(exception) ?? 0) + 1);
    else {
      compared++;
      if (sample.tagged === true) tagged++;
    }
    if (
      exception === undefined &&
      JSON.stringify(unchanged(effective)) !== JSON.stringify(unchanged(fragment))
    ) {
      failures.push({ path: sample.path, value: sample.value, effective, fragment });
    }
  }
  // Then
  console.log("Parity coverage", { compared, tagged, exceptions: Object.fromEntries(exceptions) });
  expect(compared).toBeGreaterThan(0);
  expect(tagged).toBeGreaterThan(0);
  expect(failures.slice(0, 12)).toEqual([]);
});
