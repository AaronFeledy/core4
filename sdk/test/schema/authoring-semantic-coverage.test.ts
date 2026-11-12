import { expect, test } from "bun:test";
import * as Public from "@lando/sdk/schema";
import { SchemaAST as AST, Array as Arr } from "effect";
import { semanticSiteSource } from "../../src/schema/authoring-issue-metadata.ts";

type Child = readonly [segment: string | undefined, ast: AST.AST];
const children = (ast: AST.AST): readonly Child[] => {
  switch (ast._tag) {
    case "Objects":
      return [
        ...ast.propertySignatures.map(({ name, type }): Child => [String(name), type]),
        ...ast.indexSignatures.map(({ type }): Child => ["*", type]),
      ];
    case "Arrays":
      return [
        ...ast.elements.map((element, index): Child => [String(index), element]),
        ...ast.rest.map((rest): Child => ["[]", rest]),
      ];
    case "Union":
      return ast.types.map((member): Child => [undefined, member]);
    case "Suspend":
      return [[undefined, ast.thunk()]];
    case "Declaration":
      return ast.typeParameters.map((member): Child => [undefined, member]);
    default:
      return [];
  }
};

const siteSources = (checks: readonly AST.Check<unknown>[]): readonly AST.AST[] =>
  checks.flatMap((check) => {
    if (check._tag === "FilterGroup") return siteSources(check.checks);
    const source = semanticSiteSource(check);
    return source === undefined ? [] : [source];
  });

const positions = (root: AST.AST, derived: boolean, within?: ReadonlySet<string>) => {
  const found = new Map<string, Set<AST.AST>>();
  const visit = (ast: AST.AST, path: string, ancestors: ReadonlySet<AST.AST>): void => {
    if (ancestors.has(ast)) return;
    const marked = derived
      ? siteSources(ast.checks ?? [])
      : ast.encoding !== undefined ||
          ((ast._tag === "Objects" || ast._tag === "Arrays") && ast.checks !== undefined)
        ? [ast]
        : [];
    for (const source of marked) found.set(path, (found.get(path) ?? new Set()).add(source));
    const next = new Set(ancestors).add(ast);
    const nested: readonly Child[] =
      ast._tag === "Declaration" && !derived
        ? []
        : ast.encoding === undefined
          ? children(ast)
          : derived
            ? [...ast.encoding.map(({ to }): Child => [undefined, to]), ...children(ast)]
            : [[undefined, Arr.lastNonEmpty(ast.encoding).to]];
    for (const [segment, child] of nested) {
      const childPath = segment === undefined ? path : `${path}.${segment}`;
      if (within === undefined || within.has(childPath)) visit(child, childPath, next);
    }
  };
  visit(root, "$", new Set());
  return found;
};

test.each([
  ["complete shape", Public.LandofileAuthoringShape],
  ["fragment", Public.LandofileAuthoringFragment],
  ["native fragment", Public.LandofileAuthoringFragmentNative],
] as const)(
  "keeps semantic sites for every checked container and encoded node in the %s",
  (_name, schema) => {
    const expected = positions(Public.LandofileShape.ast, false);
    const prefixes = new Set(
      [...expected.keys()].flatMap((path) =>
        path.split(".").map((_, index, segments) => segments.slice(0, index + 1).join(".")),
      ),
    );
    const actual = positions(schema.ast, true, prefixes);
    const missing = [...expected].flatMap(([path, sources]) =>
      [...sources]
        .filter((source) => !actual.get(path)?.has(source))
        .map((source) => ({ path, kind: source._tag, identifier: AST.resolveIdentifier(source) })),
    );
    expect(missing).toEqual([]);
  },
);
