import { describe, expect, test } from "bun:test";
import { parseMinimalYaml } from "@lando/paths/yaml-min";
import { parseLandofile, reset } from "@lando/sdk/landofile";
import { Effect, Predicate, Result } from "effect";
import { setAtPath, unsetAtPath } from "../../src/config-write/dot-path";
import { prepareConfigEdit } from "../../src/config-write/prepare-edit";
import { authoredTreesEqual } from "../../src/config-write/yaml-verify";

const fixtures = [
  {
    source: "# leading\na: 1 # trailing\n# standalone\nb: 2\n",
    key: "a",
    value: 3,
    expected: "# leading\na: 3 # trailing\n# standalone\nb: 2\n",
  },
  { source: "# lead\r\na: 1\r\nb: 2\n", key: "a", value: 3, expected: "# lead\r\na: 3\r\nb: 2\n" },
  { source: "a: 1", key: "a", value: 3, expected: "a: 3" },
  {
    source: "a: 'old # value' # keep\n",
    key: "a",
    value: "new # value",
    expected: 'a: "new # value" # keep\n',
  },
  {
    source: "a: # inline\n  # child\n\n  b: 1\n",
    key: "a.b",
    value: 3,
    expected: "a: # inline\n  # child\n\n  b: 3\n",
  },
  { source: "a: 1\n# tail\n", key: "b", value: 2, expected: "a: 1\nb: 2\n# tail\n" },
  { source: "a: 1", key: "b.c.d", value: 2, expected: "a: 1\nb:\n  c:\n    d: 2" },
  { source: "", key: "a", value: 2, expected: "a: 2\n" },
  // An empty `{}` left by unsetting the last child becomes a block mapping again.
  { source: "# c\na: {} # keep\nc: 2\n", key: "a.b", value: 3, expected: "# c\na: # keep\n  b: 3\nc: 2\n" },
  { source: "a: {}", key: "a.b.c", value: 3, expected: "a:\n  b:\n    c: 3" },
  { source: "# only\n", key: "a", value: 2, expected: "# only\na: 2\n" },
  {
    source: "a:\n  - one # keep\n  - two\n",
    key: "a[0]",
    value: "three",
    expected: "a:\n  - three # keep\n  - two\n",
  },
  { source: "a:\n  b: 1\n  c: 2\n# tail\nd: 4\n", key: "a", value: 3, expected: "a: 3\n# tail\nd: 4\n" },
  { source: "a: old # keep\n", key: "a", value: "${secret:x}", expected: 'a: "${secret:x}" # keep\n' },
  { source: '# c\na: ["x", "y"] # keep\nb: 1\n', key: "a", value: "z", expected: "# c\na: z # keep\nb: 1\n" },
  {
    source: '# c\na: ["x"] # keep\nb: 1\n',
    key: "a",
    value: ["y", "z"],
    expected: "# c\na: # keep\n  - y\n  - z\nb: 1\n",
  },
  { source: "a: 1\nb: 2\n", key: "a", value: { c: 3 }, expected: "a:\n  c: 3\nb: 2\n" },
];

for (const mode of ["landofile", "config"] as const) {
  const parse = (content: string) =>
    mode === "config"
      ? Effect.sync(() => parseMinimalYaml(content))
      : parseLandofile({ content, file: "/fixture.yml", cwd: "/" }).pipe(
          Effect.map((tree) => (Predicate.isObject(tree) ? tree : {})),
        );
  const prepare = async (source: string, key: string, operation: "set" | "unset", value?: unknown) => {
    const tree = await Effect.runPromise(parse(source));
    const next = operation === "set" ? setAtPath(tree, key, value) : unsetAtPath(tree, key).next;
    return Effect.runPromise(
      Effect.result(
        prepareConfigEdit({
          source,
          key,
          operation,
          next,
          tree,
          parse,
          file: "/fixture.yml",
          editCommand: "lando config edit",
        }),
      ),
    );
  };
  describe(`${mode} verified offset edits`, () => {
    test.each(fixtures)("keeps exact bytes for $key in $source", async ({ source, key, value, expected }) => {
      // Given: authored YAML and its intended mutation.
      // When
      const result = await prepare(source, key, "set", value);
      // Then
      expect(result).toEqual(Result.succeed(expected));
    });
    test.each([
      ["a:\n  - one # remove\n  - two\n# tail\n", "a[0]", "a:\n  - two\n# tail\n"],
      ["a: # keep\n  - one\n# tail\n", "a[0]", "a: [] # keep\n# tail\n"],
      ["a:\n  b: 1\n# tail\nc: 2\n", "a", "# tail\nc: 2\n"],
      ["a: 1", "a", ""],
      ["a: 1\nb: 2", "b", "a: 1"],
      ["a:\n  - one\n  - two", "a[1]", "a:\n  - one"],
      ["a:\n  - one", "a[0]", "a: []"],
      ["# c\na: # keep\n  b: 1\nc: 2\n", "a.b", "# c\na: {} # keep\nc: 2\n"],
    ])("removes %s at %s without rewriting untouched text", async (source, key, expected) => {
      // Given: a block mapping or scalar list.
      // When
      const result = await prepare(source, key, "unset");
      // Then
      expect(result).toEqual(Result.succeed(expected));
    });
    test.each([
      ["# keep\na: 1\na: 2\n", "a"],
      ["# keep\na: [1]\n", "a.b"],
      ["# keep\na: scalar\n", "a.b"],
      ["# keep\na:\n  - one\n", "a[3]"],
    ])("refuses uncertain edits of %s at %s", async (source, key) => {
      // Given: noncanonical authored syntax outside the supported subset.
      // When
      const result = await prepare(source, key, "set", 3);
      // Then
      expect(Result.isFailure(result)).toBe(true);
      if (Result.isFailure(result)) expect(result.failure.remediation).toContain("lando config edit");
    });
    test("allows a verified canonical fallback", async () => {
      // Given
      const source = "a: {}\n";
      // When
      const result = await prepare(source, "a.b", "set", 3);
      // Then
      expect(result).toEqual(Result.succeed("a:\n  b: 3\n"));
    });
    test("rejects exponent serialization even on canonical input", async () => {
      // Given
      const source = "a: 1\n";
      // When
      const result = await prepare(source, "a", "set", 1e21);
      // Then
      expect(Result.isFailure(result)).toBe(true);
    });
  });
}

test.each([
  ['# keep\n"a": 1\n', "a"],
  ["# keep\na: !reset\n", "a"],
  ["# keep\na: &base\n  b: 1\n", "a.b"],
  ["# keep\na:\n  b: &base value\n", "a"],
  ["# keep\na:\n  - key: value\n", "a[0]"],
  ["# keep\na: |\n  words\n", "a.b"],
])("refuses unsupported Landofile syntax %s", async (source, key) => {
  // Given
  const parse = (content: string) =>
    parseLandofile({ content, file: "/fixture.yml", cwd: "/" }).pipe(
      Effect.map((tree) => (Predicate.isObject(tree) ? tree : {})),
    );
  const tree = await Effect.runPromise(parse(source));
  // When
  const result = await Effect.runPromise(
    Effect.result(
      prepareConfigEdit({
        source,
        key,
        tree,
        next: setAtPath(tree, key, 3),
        operation: "set",
        parse,
        file: "/fixture.yml",
        editCommand: "lando app:config edit",
      }),
    ),
  );
  // Then
  expect(Result.isFailure(result)).toBe(true);
});

test("authored equality distinguishes symbol-backed directives from empty maps", () => {
  // Given
  const directive = { a: reset() };
  // When
  const equal = authoredTreesEqual(directive, { a: {} });
  // Then
  expect(equal).toBe(false);
});
