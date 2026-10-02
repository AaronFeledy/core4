import { describe, expect, test } from "bun:test";
import { LEGACY_TAGGED, type LegacyTagged } from "@lando/sdk/landofile";
import { ConfigTranslateSourceId } from "@lando/sdk/schema";
import { type TopLevelContext, lowerTopLevel } from "../src/lower-top-level.ts";

const ctx: TopLevelContext = { fallbackSourceId: "canonical", occurrenceAt: () => undefined };
const span = {
  start: { line: 3, column: 5, offset: 20 },
  end: { line: 3, column: 18, offset: 33 },
};

const makeLegacyTagged = (tag: string, value: unknown, sourceSpan: LegacyTagged["span"]): LegacyTagged => ({
  [LEGACY_TAGGED]: true,
  tag,
  value,
  span: sourceSpan,
});

describe("top-level lowering", () => {
  test("preserves include order when compose is a list", () => {
    // Given
    const document = { compose: ["docker-compose.yml", "./extra/compose.yml"] };
    // When
    const result = lowerTopLevel(document, ctx);
    // Then
    expect(result.fragment.includes).toEqual([
      { source: "docker-compose.yml", kind: "compose" },
      { source: "./extra/compose.yml", kind: "compose" },
    ]);
    expect(result.diagnostics.map(({ kind, keyPath }) => ({ kind, keyPath }))).toEqual([
      { kind: "rewritten", keyPath: ["compose", 0] },
      { kind: "rewritten", keyPath: ["compose", 1] },
    ]);
    expect(result.diagnostics.every((item) => item.sourceId === "canonical" && item.remediation)).toBe(true);
  });

  test("emits one include when compose is a string", () => {
    // Given / When
    const result = lowerTopLevel({ compose: "one.yml" }, ctx);
    // Then
    expect(result.fragment).toEqual({ includes: [{ source: "one.yml", kind: "compose" }] });
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0]).toMatchObject({ kind: "rewritten", keyPath: ["compose", 0] });
  });

  test.each([
    "../outside.yml",
    "a/../../outside.yml",
    "/outside.yml",
    "C:\\outside.yml",
    "C:/outside.yml",
    "\\\\host\\share\\compose.yml",
    "..\\outside.yml",
  ])("retains an unsupported include when its path is %s", (source) => {
    // Given / When
    const result = lowerTopLevel({ compose: [source] }, ctx);
    // Then
    expect(result.fragment).toEqual({ includes: [{ source, kind: "compose" }] });
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0]).toMatchObject({ kind: "unsupported", keyPath: ["compose", 0] });
  });

  test.each(["!load", "!import"])("omits tagged entries when compose uses %s", (tag) => {
    // Given
    const document = { compose: [makeLegacyTagged(tag, "missing.yml", span), "kept.yml"] };
    // When
    const result = lowerTopLevel(document, ctx);
    // Then
    expect(result.fragment).toEqual({ includes: [{ source: "kept.yml", kind: "compose" }] });
    expect(result.diagnostics.map(({ kind, keyPath }) => ({ kind, keyPath }))).toEqual([
      { kind: "unsupported", keyPath: ["compose", 0] },
      { kind: "rewritten", keyPath: ["compose", 1] },
    ]);
  });

  test("accepts parent traversal when it remains inside the root", () => {
    // Given / When
    const result = lowerTopLevel({ compose: ["extra/../compose.yml"] }, ctx);
    // Then
    expect(result.diagnostics.map(({ kind }) => kind)).toEqual(["rewritten"]);
  });

  test("splits patterns when excludes contains negations", () => {
    // Given / When
    const result = lowerTopLevel({ excludes: ["vendor", "node_modules", "!node_modules/keep"] }, ctx);
    // Then
    expect(result.fragment).toEqual({});
    expect(result.appMountExcludes).toEqual(["vendor", "node_modules"]);
    expect(result.appMountIncludes).toEqual(["node_modules/keep"]);
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0]).toMatchObject({ kind: "rewritten", keyPath: ["excludes"] });
    expect(result.diagnostics[0]?.message).toContain("appMount.excludes");
  });

  test.each([".env", [".env", ".env.local"]])("preserves env_file when supplied as %j", (env_file) => {
    // Given / When
    const result = lowerTopLevel({ env_file }, ctx);
    // Then
    expect(result).toEqual({
      fragment: { env_file },
      appMountExcludes: [],
      appMountIncludes: [],
      diagnostics: [],
    });
  });

  test.each(["volumes", "networks"])("normalizes shorthand when %s contains named resources", (key) => {
    // Given
    const document = { [key]: { "my-data": null, go_path: { driver: "local" }, empty: undefined } };
    // When
    const result = lowerTopLevel(document, ctx);
    // Then
    expect(result).toEqual({
      fragment: { [key]: { "my-data": {}, go_path: { driver: "local" }, empty: {} } },
      appMountExcludes: [],
      appMountIncludes: [],
      diagnostics: [],
    });
    expect(document[key]?.["my-data"]).toBeNull();
  });

  test("preserves extension values when x-prefixed keys are present", () => {
    // Given
    const document = { "x-vars": ["A=1"], "x-service": { api: 4 } };
    // When
    const result = lowerTopLevel(document, ctx);
    // Then
    expect(result).toEqual({
      fragment: document,
      appMountExcludes: [],
      appMountIncludes: [],
      diagnostics: [],
    });
    expect(result.fragment["x-service"]).toBe(document["x-service"]);
  });

  test.each([{}, { compose: [], volumes: {}, networks: {} }])(
    "emits nothing when input is empty: %j",
    (document) => {
      // Given / When
      const result = lowerTopLevel(document, ctx);
      // Then
      expect(result).toEqual({ fragment: {}, appMountExcludes: [], appMountIncludes: [], diagnostics: [] });
    },
  );

  test("omits includes when every entry is tagged", () => {
    // Given / When
    const result = lowerTopLevel({ compose: makeLegacyTagged("!load", "missing.yml", span) }, ctx);
    // Then
    expect(result.fragment).toEqual({});
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0]).toMatchObject({ kind: "unsupported", keyPath: ["compose", 0] });
  });

  test("uses occurrence provenance when it is available", () => {
    // Given
    const context: TopLevelContext = {
      ...ctx,
      occurrenceAt: (keyPath) => ({
        sourceId: ConfigTranslateSourceId.make("local"),
        layer: "local",
        keyPath,
        span,
      }),
    };
    // When
    const result = lowerTopLevel({ compose: "one.yml" }, context);
    // Then
    expect(result.diagnostics[0]).toMatchObject({
      sourceId: "local",
      keyPath: ["compose", 0],
      span: { start: { line: 3, column: 5 }, end: { line: 3, column: 18 } },
    });
    expect(result.diagnostics[0]?.span?.start).not.toHaveProperty("offset");
  });

  test("is deterministic when the same input is lowered twice", () => {
    // Given
    const document = {
      excludes: ["vendor"],
      "x-vars": ["A=1"],
      compose: ["one.yml", "../two.yml"],
      networks: { "my-network": null },
    };
    // When
    const results = [lowerTopLevel(document, ctx), lowerTopLevel(document, ctx)];
    // Then
    expect(results[0]).toEqual(results[1]);
    expect(Object.keys(results[0]?.fragment ?? {})).toEqual(["x-vars", "includes", "networks"]);
    expect(results[0]?.fragment.networks).toEqual({ "my-network": {} });
    expect(results[0]?.diagnostics.map(({ keyPath }) => keyPath)).toEqual([
      ["excludes"],
      ["compose", 0],
      ["compose", 1],
    ]);
  });

  test.each([
    ["plugins", { "@lando/mailpit": "^1" }, "plugin"],
    ["pluginDirs", ["./plugins"], "plugin"],
    ["keys", ["id_ed25519"], "SSH agent sidecar"],
  ])("drops top-level %s with manual remediation", (key, value, remediation) => {
    // Given / When
    const result = lowerTopLevel({ [key]: value }, ctx);
    // Then
    expect(result.fragment).toEqual({});
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0]).toMatchObject({ kind: "dropped", keyPath: [key] });
    expect(result.diagnostics[0]?.remediation).toContain(remediation);
  });
});
