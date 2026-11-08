import { expect, test } from "bun:test";
import { createBufferedRendererIO } from "@lando/renderer/io";
import { type ConfigTranslateDiagnostic, ConfigTranslateSourceId } from "@lando/sdk/schema";
import { Effect, Layer, Schema } from "effect";
import {
  type AppConfigTranslateResult,
  AppConfigTranslateResultSchema,
  renderConfigTranslateResult,
  renderTranslateDiagnostics,
} from "../../src/cli/commands/app-config-translate-output.ts";
import { runWithRendererHandling } from "../../src/cli/renderer-boundary.ts";

const sourceId = ConfigTranslateSourceId.make(".lando.yml");
const kinds = ["generated", "rewritten", "dropped", "needs-review", "non-portable", "unsupported"] as const;
const diagnostics: readonly ConfigTranslateDiagnostic[] = [
  ...kinds.map((kind) => ({
    kind,
    sourceId,
    keyPath: [kind],
    message: `Message ${kind}`,
    remediation: `Fix ${kind}`,
  })),
  ...["source", "owner", "exclude"].map((leaf) => ({
    kind: "dropped" as const,
    sourceId,
    keyPath: ["services", "web", "mounts", 0, leaf],
    message: "Mount field omitted",
    remediation: "Configure the mount manually",
  })),
];
const preview = {
  mode: "preview",
  inputPath: ".lando.yml",
  translator: "synthetic",
  target: "lando4",
  files: [".lando.yml"],
  targets: [{ layer: "canonical", path: ".lando.yml", content: "name: demo\n" }],
  content: "name: demo\n",
  diagnostics,
  deletions: [],
} satisfies AppConfigTranslateResult;

test("summarizes all diagnostic kinds in impact order when previewing", () => {
  // Given: unsorted diagnostics with every kind and three sibling drops.
  // When: rendering the preview.
  const text = renderConfigTranslateResult(preview);
  const comments = text.split("\n").filter((line) => line.startsWith("#"));
  // Then: counts reflect original diagnostics, while identical siblings share a located line.
  expect(comments[0]).toBe(
    "# 1 unsupported (blocks --write), 1 non-portable (blocks --write), 1 needs-review, 4 dropped, 1 rewritten, 1 generated",
  );
  expect(
    comments.filter((line) => /^# [!~?+\-] \[/u.test(line)).map((line) => line.match(/\[([^\]]+)\]/u)?.[1]),
  ).toEqual(["unsupported", "non-portable", "needs-review", "dropped", "dropped", "rewritten", "generated"]);
  expect(text).toContain(".lando.yml:services.web.mounts.0.{source, owner, exclude}");
  for (const kind of ["unsupported", "non-portable", "needs-review", "dropped"])
    expect(text).toContain(`#   Next: Fix ${kind}`);
  expect(Bun.YAML.parse(text)).toEqual({ name: "demo" });
});

test.each(["kind", "source", "parent", "message", "remediation"] as const)(
  "keeps diagnostics separate when their %s differs",
  (field) => {
    // Given: siblings that differ in one grouping field.
    const base: ConfigTranslateDiagnostic = {
      kind: "dropped",
      sourceId,
      keyPath: ["mount", "a"],
      message: "Omitted",
      remediation: "Fix",
    };
    const changes = {
      kind: { kind: "rewritten" as const },
      source: { sourceId: ConfigTranslateSourceId.make(".lando.local.yml") },
      parent: { keyPath: ["other", "b"] },
      message: { message: "Different" },
      remediation: { remediation: "Other fix" },
    };
    // When: rendering the pair.
    const text = renderTranslateDiagnostics([base, { ...base, keyPath: ["mount", "b"], ...changes[field] }]);
    // Then: neither source location is collapsed into a sibling list.
    expect(text).not.toContain("{a, b}");
    expect(text.split("\n").filter((line) => /^# [~\-] \[/u.test(line))).toHaveLength(2);
  },
);

test("keeps multiline diagnostic text inside YAML comments", () => {
  // Given: plugin messages, remediation and paths containing line breaks.
  const multiline = {
    kind: "dropped",
    sourceId,
    keyPath: ["a\nb"],
    message: "First\nname: injected",
    remediation: "Fix\r\nThen retry",
  } satisfies ConfigTranslateDiagnostic;
  // When: rendering a preview.
  const text = renderConfigTranslateResult({ ...preview, diagnostics: [multiline] });
  // Then: diagnostic content cannot become YAML data.
  expect(
    text
      .split("\n")
      .slice(1)
      .every((line) => line.startsWith("# ")),
  ).toBe(true);
  expect(Bun.YAML.parse(text)).toEqual({ name: "demo" });
});

test("keeps whole-document diagnostics separate from top-level fields", () => {
  // Given: a root and a field with otherwise identical diagnostic metadata.
  const root: ConfigTranslateDiagnostic = { kind: "dropped", sourceId, keyPath: [], message: "Omitted" };
  // When: rendering both locations.
  const text = renderTranslateDiagnostics([root, { ...root, keyPath: ["field"] }]);
  // Then: neither location disappears into the other.
  expect(text).toContain("(.lando.yml:)");
  expect(text).toContain("(.lando.yml:field)");
});

test("leaves JSON diagnostics byte-identical when human rendering groups them", async () => {
  // Given: the translator's original diagnostic array.
  const before = JSON.stringify(diagnostics);
  const io = createBufferedRendererIO();
  // When: formatting human output and encoding the result schema.
  renderConfigTranslateResult(preview);
  await runWithRendererHandling(Effect.succeed(preview), {
    runtime: Layer.empty,
    rendererMode: "plain",
    resultFormat: "json",
    command: "app:config:translate",
    resultSchema: AppConfigTranslateResultSchema,
    io,
    render: (result) => renderConfigTranslateResult(result),
    formatError: ({ error }) => String(error),
    setExitCode: () => {},
  });
  const { result: encoded } = Schema.decodeUnknownSync(
    Schema.Struct({ result: AppConfigTranslateResultSchema }),
  )(JSON.parse(io.stdout()));
  // Then: no sorting, grouping or message changes leak into the payload.
  if (encoded.mode !== "preview") throw new Error("Expected preview");
  expect(JSON.stringify(encoded.diagnostics)).toBe(before);
  expect(JSON.stringify(diagnostics)).toBe(before);
});

test("ends a successful write with receipt, backup locations, review counts and lint command", () => {
  // Given: a write that replaced and removed source files.
  const result: AppConfigTranslateResult = {
    mode: "write",
    inputPath: ".lando.yml",
    target: "lando4",
    written: [".lando.yml"],
    removed: ["compose.yml"],
    backups: [".lando.yml.bak.abc", "compose.yml.bak.def"],
    diagnostics,
    deletions: [],
  };
  // When: rendering the receipt.
  const text = renderConfigTranslateResult(result);
  // Then: all status output remains comments, including the actionable receipt footer.
  expect(text.split("\n").every((line) => line.startsWith("# "))).toBe(true);
  expect(text).toEndWith(
    "# Receipt: 1 written, 1 removed, 2 backups\n# backup: .lando.yml.bak.abc\n# backup: compose.yml.bak.def\n# Review: 1 needs-review, 4 dropped\n# Next: lando app:config:lint",
  );
});
