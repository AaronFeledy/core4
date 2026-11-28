import { expect, test } from "bun:test";
import {
  type HomeGuideEntry,
  type MappedGuide,
  validateHomeGuides,
} from "../../../scripts/guides/home-guide-registry.ts";

const parsed = (scenarioCount = 1, guideId = "demo"): MappedGuide => ({
  kind: "parsed",
  guideId,
  scenarioCount,
});

const guideMap = (
  entries: ReadonlyArray<[string, MappedGuide | undefined]>,
): Map<string, MappedGuide | undefined> => new Map(entries);

const entry = (
  feature: string,
  sources: readonly string[],
  guide = "docs/guides/demo.mdx",
): HomeGuideEntry => ({
  feature,
  guide,
  sources,
});

const codesFor = (
  entries: readonly HomeGuideEntry[],
  guides: Map<string, MappedGuide | undefined>,
  files: readonly string[],
): readonly string[] =>
  validateHomeGuides({ entries, guides, files }).diagnostics.map((diagnostic) => diagnostic.code);

test("an empty map is a failure, never a pass", () => {
  expect(codesFor([], guideMap([]), [])).toEqual(["registry.empty"]);
});

test("rejects entries that are not a kebab feature with a guide and sources", () => {
  const guides = guideMap([["docs/guides/demo.mdx", parsed()]]);
  const codes = codesFor(
    [entry("Not_Kebab", ["src/a.ts"]), entry("missing-guide", ["src/a.ts"], ""), entry("empty-sources", [])],
    guides,
    ["src/a.ts"],
  );
  expect(codes).toEqual(["registry.schema", "registry.schema", "registry.schema"]);
});

test("rejects a feature declared twice", () => {
  const guides = guideMap([["docs/guides/demo.mdx", parsed()]]);
  expect(
    codesFor([entry("demo", ["src/a.ts"]), entry("demo", ["src/b.ts"])], guides, ["src/a.ts", "src/b.ts"]),
  ).toContain("registry.duplicate-feature");
});

test("rejects absolute, escaping, and backslash sources", () => {
  const guides = guideMap([
    ["docs/guides/a.mdx", parsed()],
    ["docs/guides/b.mdx", parsed()],
    ["docs/guides/c.mdx", parsed()],
  ]);
  const codes = codesFor(
    [
      entry("absolute", ["/etc/passwd"], "docs/guides/a.mdx"),
      entry("escaping", ["src/../outside.ts"], "docs/guides/b.mdx"),
      entry("backslash", ["src\\win.ts"], "docs/guides/c.mdx"),
    ],
    guides,
    [],
  );
  expect(codes).toEqual(["registry.invalid-source", "registry.invalid-source", "registry.invalid-source"]);
});

test("rejects a guide outside the discovery roots", () => {
  const guides = guideMap([["docs/guides/demo.mdx", parsed()]]);
  const codes = codesFor([entry("demo", ["src/a.ts"], "docs/other-page.mdx")], guides, ["src/a.ts"]);
  expect(codes).toContain("registry.unknown-guide");
});

test("rejects a mapped guide the compiler cannot parse", () => {
  const guides = guideMap([["docs/guides/demo.mdx", { kind: "invalid", error: "bad frontmatter" }]]);
  const codes = codesFor([entry("demo", ["src/a.ts"])], guides, ["src/a.ts"]);
  expect(codes).toContain("registry.guide-invalid");
});

test("rejects a mapped guide with no scenario", () => {
  const guides = guideMap([["docs/guides/demo.mdx", parsed(0)]]);
  const codes = codesFor([entry("demo", ["src/a.ts"])], guides, ["src/a.ts"]);
  expect(codes).toContain("registry.guide-without-scenario");
});

test("rejects a source that matches no git-visible file and says how to fix the map", () => {
  const guides = guideMap([["docs/guides/demo.mdx", parsed()]]);
  const registry = validateHomeGuides({
    entries: [entry("demo", ["src/gone.ts", "src/empty/*.ts"])],
    guides,
    files: ["src/a.ts"],
  });
  expect(registry.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
    "registry.unmatched-source",
    "registry.unmatched-source",
  ]);
  const messages = registry.diagnostics.map((diagnostic) => diagnostic.message);
  expect(messages).toEqual([
    expect.stringMatching(/"demo".*"src\/empty\/\*\.ts".*scripts\/guides\/home-guides\.ts.*Update or remove/),
    expect.stringMatching(/"demo".*"src\/gone\.ts".*scripts\/guides\/home-guides\.ts.*Update or remove/),
  ]);
});

test("rejects a file two features claim", () => {
  const guides = guideMap([
    ["docs/guides/demo.mdx", parsed()],
    ["recipes/demo/README.mdx", parsed()],
  ]);
  const codes = codesFor(
    [entry("literal-owner", ["src/shared.ts"]), entry("glob-owner", ["src/*.ts"], "recipes/demo/README.mdx")],
    guides,
    ["src/shared.ts"],
  );
  expect(codes).toContain("registry.overlap");
});

test("accepts a recipe README as a home guide", () => {
  const guides = guideMap([["recipes/demo/README.mdx", parsed()]]);
  const registry = validateHomeGuides({
    entries: [entry("recipe-demo", ["src/a.ts"], "recipes/demo/README.mdx")],
    guides,
    files: ["src/a.ts"],
  });
  expect(registry.diagnostics).toEqual([]);
});

test("answers ownership for a covered path, a deleted path a glob still covers, and an uncovered path", () => {
  const guides = guideMap([["docs/guides/demo.mdx", parsed()]]);
  const registry = validateHomeGuides({
    entries: [entry("demo", ["src/literal.ts", "src/*.ts"])],
    guides,
    files: ["src/literal.ts", "src/other.ts"],
  });
  expect(registry.diagnostics).toEqual([]);
  expect(registry.ownersOf("src/literal.ts").map((owner) => owner.feature)).toEqual(["demo"]);
  expect(registry.ownersOf("src/deleted.ts").map((owner) => owner.feature)).toEqual(["demo"]);
  expect(registry.ownersOf("docs/guides/demo.mdx")).toEqual([]);
  expect(registry.guide("docs/guides/demo.mdx")).toEqual(parsed());
});

test("attributes a deleted path no file list contains to every matching feature", () => {
  const guides = guideMap([
    ["docs/guides/demo.mdx", parsed()],
    ["recipes/demo/README.mdx", parsed()],
  ]);
  const registry = validateHomeGuides({
    entries: [
      entry("nested-sources", ["src/**/x.ts"]),
      entry("flat-sources", ["src/*.ts"], "recipes/demo/README.mdx"),
    ],
    guides,
    files: ["src/legacy/x.ts", "src/kept.ts"],
  });
  expect(registry.diagnostics).toEqual([]);
  expect(
    registry
      .ownersOf("src/x.ts")
      .map((owner) => owner.feature)
      .sort(),
  ).toEqual(["flat-sources", "nested-sources"]);
});

test.each([
  ["docs/guides/./demo.mdx", "a ./ segment"],
  ["docs//guides/demo.mdx", "a doubled slash"],
  ["docs/guides\\demo.mdx", "a backslash"],
  ["docs/guides/demo.mdx/", "a trailing slash"],
] as const)("rejects the non-canonical guide path %s", (guidePath) => {
  const guides = guideMap([["docs/guides/demo.mdx", parsed()]]);
  const registry = validateHomeGuides({
    entries: [entry("demo", ["src/a.ts"], guidePath)],
    guides,
    files: ["src/a.ts"],
  });
  expect(registry.diagnostics.map((diagnostic) => diagnostic.code)).toContain("registry.invalid-guide");
  expect(registry.diagnostics.map((diagnostic) => diagnostic.message).join("\n")).toContain("not canonical");
});
