import { describe, expect, test } from "bun:test";
import { LandofileParseError } from "../../src/errors/index.ts";
import {
  type LegacyNode,
  type LegacyScalarNode,
  type LegacyScalarStyle,
  type LegacySourceSpan,
  type LegacyTree,
  isLegacyTagged,
} from "../../src/landofile/legacy/contract.ts";
import { expansionBudget, resolveLegacyLimits } from "../../src/landofile/legacy/limits.ts";
import { projectLegacyTree } from "../../src/landofile/legacy/project.ts";
import { resolvePlainScalar } from "../../src/landofile/legacy/scalars.ts";

const span: LegacySourceSpan = {
  start: { line: 3, column: 7, offset: 12 },
  end: { line: 3, column: 10, offset: 15 },
};
const scalar = (text: string, style: LegacyScalarStyle = "plain", tag?: string): LegacyScalarNode => ({
  kind: "scalar",
  text,
  style,
  tag,
  anchor: undefined,
  span,
});
const mapping = (entries: ReadonlyArray<readonly [string, LegacyNode]>, tag?: string): LegacyNode => ({
  kind: "mapping",
  entries: entries.map(([key, value]) => ({ key: scalar(key), value, span })),
  tag,
  anchor: undefined,
  span,
});
const seq = (items: ReadonlyArray<LegacyNode>, tag?: string): LegacyNode => ({
  kind: "sequence",
  items,
  tag,
  anchor: undefined,
  span,
});
const alias = (name: string): LegacyNode => ({ kind: "alias", name, span });
const tree = (root: LegacyNode | null, anchors: ReadonlyMap<string, LegacyNode> = new Map()): LegacyTree => ({
  root,
  anchors,
  aliasCount: 0,
});
const project = (input: LegacyTree, limits = resolveLegacyLimits(), sourceLength = 100) =>
  projectLegacyTree({ tree: input, file: ".lando.yml", limits, sourceLength });
const rejects = (run: () => unknown, message: string): void => {
  // When / Then: errors retain actionable source coordinates.
  let failure: unknown;
  try {
    run();
  } catch (error) {
    if (!(error instanceof LandofileParseError)) throw error;
    failure = error;
  }
  expect(failure).toBeInstanceOf(LandofileParseError);
  if (!(failure instanceof LandofileParseError)) throw new Error("Expected parse failure");
  expect(failure.message).toContain(message);
  expect(failure).toMatchObject({ filePath: ".lando.yml", line: 3, column: 7 });
  expect(failure.remediation).toBeTruthy();
};

describe("legacy scalar projection", () => {
  const cases: ReadonlyArray<readonly [string, string | number | boolean | null]> = [
    ...["", "~", "null", "Null", "NULL"].map((text): readonly [string, null] => [text, null]),
    ...["true", "True", "TRUE"].map((text): readonly [string, boolean] => [text, true]),
    ...["false", "False", "FALSE"].map((text): readonly [string, boolean] => [text, false]),
    ..."yes|no|on|off|y|n|YES|No|ON|Off|Y|N|007|-007|+007|1_000|0xG|0o8|0b2|Trueish|1:20|2020-01-01| 1|1\n"
      .split("|")
      .map((text): readonly [string, string] => [text, text]),
    ["0", 0],
    ["-0", -0],
    ["+12", 12],
    ["-12", -12],
    ["0x1F", 31],
    ["0o17", 15],
    ["0b101", 5],
    [".5", 0.5],
    ["-.5", -0.5],
    ["1.", 1],
    ["1.25", 1.25],
    ["1e3", 1000],
    ["1E-3", 0.001],
    [".inf", Number.POSITIVE_INFINITY],
    [".Inf", Number.POSITIVE_INFINITY],
    [".INF", Number.POSITIVE_INFINITY],
    ["+.INF", Number.POSITIVE_INFINITY],
    ["-.Inf", Number.NEGATIVE_INFINITY],
    [".NaN", Number.NaN],
    [".nan", Number.NaN],
    [".NAN", Number.NaN],
  ];
  test.each(cases)("types plain %j", (text, expected) => {
    // Given / When / Then
    expect(resolvePlainScalar(text)).toBe(expected);
  });
  test.each(["single", "double", "literal", "folded"] as const)("preserves %s text", (style) => {
    // Given
    const input = tree(seq([scalar("true", style), scalar("007\n", style), scalar("null", style)]));
    // When / Then
    expect(project(input).value).toEqual(["true", "007\n", "null"]);
  });
  test("distinguishes an empty document from explicit null", () => {
    // Given / When / Then
    expect(project(tree(null))).toEqual({ value: undefined, tags: [] });
    expect(project(tree(scalar("null"))).value).toBeNull();
  });
});

describe("legacy references", () => {
  test("deep-copies every alias expansion", () => {
    // Given
    const base = mapping([["nested", seq([mapping([["value", scalar("42")]])])]]);
    // When
    const { value } = project(tree(seq([alias("base"), alias("base")]), new Map([["base", base]])));
    // Then
    expect(value).toEqual([{ nested: [{ value: 42 }] }, { nested: [{ value: 42 }] }]);
    if (!Array.isArray(value)) throw new Error("Expected array");
    expect(value[0]).not.toBe(value[1]);
    expect(value[0].nested).not.toBe(value[1].nested);
    expect(value[0].nested[0]).not.toBe(value[1].nested[0]);
  });
  test("rejects recursive aliases", () => {
    // Given
    const input = tree(alias("a"), new Map([["a", mapping([["self", alias("a")]])]]));
    rejects(() => project(input), "Detected a recursive YAML alias graph through *a.");
  });
  test("rejects missing anchors", () => {
    // Given
    rejects(() => project(tree(alias("missing"))), "Unknown YAML alias *missing.");
  });
  test("bounds alias depth at the configured limit", () => {
    // Given
    const input = tree(
      alias("a"),
      new Map([
        ["a", alias("b")],
        ["b", scalar("done")],
      ]),
    );
    // When / Then
    expect(project(input, resolveLegacyLimits({ maxDepth: 2 })).value).toBe("done");
    rejects(
      () => project(input, resolveLegacyLimits({ maxDepth: 1 })),
      "YAML alias graph exceeded the maximum depth of 1.",
    );
  });
  test("rejects expansion beyond the node budget", () => {
    // Given: compact alias fan-out expands exponentially.
    const anchors = new Map<string, LegacyNode>([["0", scalar("leaf")]]);
    for (let i = 1; i <= 16; i++) anchors.set(String(i), seq([alias(String(i - 1)), alias(String(i - 1))]));
    const input = tree(alias("16"), anchors);
    rejects(
      () => project(input),
      `Resolving YAML aliases exceeded the maximum of ${expansionBudget(100)} expanded nodes.`,
    );
  });
  test("accepts the exact expansion budget and honors source length", () => {
    // Given: each alias plus its target costs two visits, plus the root sequence.
    const input = tree(seq(Array.from({ length: 25000 }, () => alias("a"))), new Map([["a", scalar("x")]]));
    // When / Then
    expect(project(input, resolveLegacyLimits(), 50001).value).toHaveLength(25000);
    rejects(() => project(input), "Resolving YAML aliases exceeded the maximum of 50000 expanded nodes.");
  });
  test("names both actual and permitted alias counts", () => {
    // Given
    const input = { ...tree(alias("a"), new Map([["a", scalar("x")]])), aliasCount: 7 };
    // When / Then
    expect(project(input, resolveLegacyLimits({ maxAliases: 7 })).value).toBe("x");
    rejects(() => project(input, resolveLegacyLimits({ maxAliases: 2 })), "7 aliases > 2");
  });
});

describe("legacy merges and tags", () => {
  const anchors = new Map<string, LegacyNode>([
    [
      "a",
      mapping([
        ["shared", scalar("first")],
        ["a", scalar("1")],
      ]),
    ],
    [
      "b",
      mapping([
        ["shared", scalar("second")],
        ["b", scalar("2")],
      ]),
    ],
  ]);
  test.each([false, true])("explicit keys beat merges regardless of position (%s)", (explicitFirst) => {
    // Given
    const entries: ReadonlyArray<readonly [string, LegacyNode]> = [
      ["shared", scalar("explicit")],
      ["<<", alias("a")],
    ];
    // When
    const { value } = project(tree(mapping(explicitFirst ? entries : [...entries].reverse()), anchors));
    // Then: exact equality also excludes the merge key.
    expect(value).toEqual({ shared: "explicit", a: 1 });
  });
  test("earlier merged sources win", () => {
    // Given / When
    const { value } = project(tree(mapping([["<<", seq([alias("a"), alias("b")])]]), anchors));
    // Then
    expect(value).toEqual({ shared: "first", a: 1, b: 2 });
  });
  test.each([scalar("null"), scalar("false"), scalar("word"), seq([scalar("1")])])(
    "rejects non-mapping merges %j",
    (target) => {
      // Given
      rejects(
        () => project(tree(mapping([["<<", target]]))),
        "YAML merge target must be a mapping or a sequence of mappings.",
      );
    },
  );
  test("preserves prototype-looking keys as own data properties", () => {
    // Given / When
    const { value } = project(
      tree(
        mapping([
          ["__proto__", scalar("safe")],
          ["constructor", scalar("1")],
        ]),
      ),
    );
    // Then
    expect(value).toEqual(
      Object.fromEntries([
        ["__proto__", "safe"],
        ["constructor", 1],
      ]),
    );
    expect(Object.getPrototypeOf(value)).toBe(Object.prototype);
  });
  test.each([scalar("./missing.yml", "plain", "!load"), mapping([], "!import"), seq([], "!custom")])(
    "retains tagged values %j",
    (node) => {
      // Given / When
      const { value, tags } = project(tree(node));
      // Then
      expect(isLegacyTagged(value)).toBe(true);
      if (!isLegacyTagged(value)) throw new Error("Expected tag marker");
      expect(value.span).toBe(span);
      expect(tags).toEqual([{ tag: value.tag, span, path: [] }]);
      expect(value.value).toEqual(
        node.kind === "scalar" ? "./missing.yml" : node.kind === "mapping" ? {} : [],
      );
    },
  );
  test("inventories tags in document order through mappings and sequences", () => {
    // Given
    const child = scalar("true", "plain", "!leaf");
    const input = tree(mapping([["items", seq([mapping([["name", child]], "!item")], "!list")]], "!root"));
    // When
    const { value, tags } = project(input);
    // Then
    expect(tags).toEqual([
      { tag: "!root", span, path: [] },
      { tag: "!list", span, path: ["items"] },
      { tag: "!item", span, path: ["items", 0] },
      { tag: "!leaf", span, path: ["items", 0, "name"] },
    ]);
    expect(value).toMatchObject({
      tag: "!root",
      value: {
        items: { tag: "!list", value: [{ tag: "!item", value: { name: { tag: "!leaf", value: true } } }] },
      },
    });
  });
  test("does not duplicate source tag occurrences at alias uses", () => {
    // Given
    const tagged = scalar("file.yml", "plain", "!load");
    // When
    const result = project(tree(seq([tagged, alias("a")]), new Map([["a", tagged]])));
    // Then
    expect(result.tags).toEqual([{ tag: "!load", span, path: [0] }]);
    expect(result.value).toMatchObject([{ tag: "!load" }, { tag: "!load" }]);
  });
});
