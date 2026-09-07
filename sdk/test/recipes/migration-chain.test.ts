import { expect, test } from "bun:test";
import { Either } from "effect";
import {
  canonicalJson,
  classifyHunk,
  deriveHunkId,
  selectMigrationPath,
  validateMigrationChain,
} from "../../src/recipes/migration-chain.ts";
import type { RecipeProducer } from "../../src/schema/recipe-identity.ts";
import type {
  RecipeMigration,
  RecipeMigrationHunk,
  RecipeSnapshot,
} from "../../src/schema/recipe-snapshot.ts";

const producer = (version: number): RecipeProducer => ({
  sourceKind: "bundled",
  packageName: "recipes",
  recipeId: "php",
  manifestVersion: `${version}.0.0`,
  contentDigest: `sha256:${"a".repeat(64)}`,
});
const snapshot = (identity: RecipeProducer): RecipeSnapshot => ({
  identity,
  optionTypes: {},
  defaults: {},
  template: { expression: { kind: "Literal", value: "ok" } },
  assets: [],
});
const edge = (from: number, to: number): RecipeMigration => ({
  from: producer(from),
  to: producer(to),
  fromSnapshot: snapshot(producer(from)),
  toSnapshot: snapshot(producer(to)),
  hunks: [],
});
const hunk = (migration: RecipeMigration): RecipeMigrationHunk => ({
  id: deriveHunkId({
    producer: migration.to,
    from: migration.from,
    to: migration.to,
    kind: "replace",
    layer: "base",
    path: "services.web",
  }),
  kind: "replace",
  layer: "base",
  path: "services.web",
  old: "old",
  new: "new",
});
const reason = (
  chain: ReadonlyArray<RecipeMigration>,
  target = producer(3),
  raw?: ReadonlyArray<unknown>,
) => {
  const result = validateMigrationChain(target, chain, raw);
  return Either.isLeft(result) ? result.left.reason : "ok";
};
test("canonical JSON sorts nested keys but preserves array order", () => {
  expect(canonicalJson({ z: [2, 1], a: { y: 2, x: 1 } })).toBe('{"a":{"x":1,"y":2},"z":[2,1]}');
});
test("hunk id stability and layer sensitivity", () => {
  const input = {
    producer: producer(2),
    from: producer(1),
    to: producer(2),
    kind: "replace",
    layer: "base",
    path: "services.web",
  } as const;
  expect(deriveHunkId(input)).toBe(deriveHunkId({ ...input }));
  expect(deriveHunkId(input)).not.toBe(deriveHunkId({ ...input, layer: "local" }));
});
test("callable-apply precedes all chain checks", () =>
  expect(reason([], producer(3), [{ apply() {} }])).toBe("callable-apply"));
test("nested callable hunk payload is callable-apply", () =>
  expect(
    reason([], producer(3), [
      {
        hunks: [
          {
            old() {
              return "ran";
            },
          },
        ],
      },
    ]),
  ).toBe("callable-apply"));
test("family-mismatch", () =>
  expect(reason([{ ...edge(1, 3), from: { ...producer(1), sourceKind: "local" } }])).toBe("family-mismatch"));
test("reverse", () => expect(reason([edge(3, 1)])).toBe("reverse"));
test("duplicate", () => expect(reason([edge(1, 3), edge(1, 3)])).toBe("duplicate"));
test("fork", () => expect(reason([edge(1, 2), edge(1, 3)])).toBe("fork"));
test("overlap", () => expect(reason([edge(1, 3), edge(2, 3)])).toBe("overlap"));
test("gap", () => expect(reason([edge(1, 2)])).toBe("gap"));
test("cycle is rejected by the earlier reverse check", () =>
  expect(reason([edge(1, 2), edge(2, 1)])).toBe("reverse"));
test("snapshot-mismatch", () =>
  expect(reason([{ ...edge(1, 3), fromSnapshot: snapshot(producer(2)) }])).toBe("snapshot-mismatch"));
test("identity-drift", () =>
  expect(
    reason([
      edge(1, 2),
      { ...edge(2, 3), fromSnapshot: { ...snapshot(producer(2)), defaults: { php: "8" } } },
    ]),
  ).toBe("identity-drift"));
test("hunk-id-mismatch", () =>
  expect(reason([{ ...edge(1, 3), hunks: [{ ...hunk(edge(1, 3)), id: `hunk-${"0".repeat(24)}` }] }])).toBe(
    "hunk-id-mismatch",
  ));
test("hunk-id-collision", () =>
  expect(reason([{ ...edge(1, 3), hunks: [hunk(edge(1, 3)), hunk(edge(1, 3))] }])).toBe("hunk-id-collision"));
test("sorts a contiguous chain without treating its shared endpoint as a cycle", () => {
  expect(Either.getOrThrow(validateMigrationChain(producer(3), [edge(2, 3), edge(1, 2)]))).toEqual([
    edge(1, 2),
    edge(2, 3),
  ]);
});
test("selectMigrationPath missing old snapshot is no-mutation", () => {
  expect(selectMigrationPath([edge(1, 3)], undefined, producer(3))).toEqual({
    kind: "no-mutation",
    reason: "missing-old-snapshot",
  });
});
test("selectMigrationPath recognizes identity mismatch and already current", () => {
  expect(selectMigrationPath([], { ...producer(3), sourceKind: "local" }, producer(3))).toEqual({
    kind: "no-mutation",
    reason: "identity-mismatch",
  });
  expect(selectMigrationPath([], producer(3), producer(3))).toEqual({
    kind: "no-mutation",
    reason: "already-current",
  });
});
test("selectMigrationPath returns the suffix from the recorded identity", () => {
  expect(selectMigrationPath([edge(1, 2), edge(2, 3)], producer(2), producer(3))).toEqual({
    kind: "path",
    migrations: [edge(2, 3)],
  });
});
test.each([
  ["already-satisfied", "new", "replace"],
  ["selected", "old", "replace"],
  ["blocking", "custom", "replace"],
  ["retained-option", "custom", "option-default"],
] as const)("hunk classification %s", (expected, current, kind) => {
  expect(classifyHunk({ ...hunk(edge(1, 2)), kind, old: "old", new: "new" }, { current })).toBe(expected);
});
test("add and remove classify absence", () => {
  expect(
    classifyHunk({ id: "x", kind: "add", layer: "base", path: "x", new: 1 }, { current: undefined }),
  ).toBe("selected");
  expect(
    classifyHunk({ id: "x", kind: "remove", layer: "base", path: "x", old: 1 }, { current: undefined }),
  ).toBe("already-satisfied");
});
