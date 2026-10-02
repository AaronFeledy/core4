import { expect, test } from "bun:test";
import { parseLegacyLandofile } from "@lando/sdk/landofile";
import { ConfigTranslateInput, ConfigTranslateSourceId } from "@lando/sdk/schema";
import { Effect, Schema } from "effect";
import { mergeLegacySources, toMergedValue } from "../src/legacy-merge.ts";
import { legacyReferenceDiagnostics } from "../src/legacy-references.ts";
import { lando3ConfigTranslator } from "../src/translator.ts";

const translate = (text: string) =>
  Effect.runPromise(
    lando3ConfigTranslator.translate(
      Schema.decodeUnknownSync(ConfigTranslateInput)({
        _tag: "landofile-document-set",
        mode: "full",
        selectedSourceIds: ["source"],
        currentLowerV4Fragments: [],
        writableLayerIds: ["canonical"],
        documents: [
          {
            sourceId: "source",
            layerId: "canonical",
            path: ".lando.yml",
            mediaType: "application/yaml",
            bytes: Buffer.from(text).toString("base64"),
            contentDigest: `sha256:${new Bun.CryptoHasher("sha256").update(text).digest("hex")}`,
          },
        ],
      }),
    ),
  );

test.each([
  "$LANDO_INFO",
  "${LANDO_MOUNT}",
  "settings.lando.php",
  "wp-config.php",
  "lando info --filter database",
  "lando info --deep",
  "lando info -d",
  "lando rebuild -s appserver",
  "lando info --service=database",
  "lando logs -t",
  "lando logs --timestamps",
  "lando version --all",
  "lando version -a",
  "lando version --component core",
  "lando version -c core",
  "lando list",
  "lando start",
  "echo ok;lando stop",
  "true&&lando restart",
  "true|lando info",
  "(lando start)",
  "`lando info`",
  "$(lando info)",
  "lando rebuild -s appserver && echo $LANDO_INFO",
])("reviews reference %s once and retains the output", async (script) => {
  // Given a string scalar at an extension path.
  const text = `name: demo\nx-script: ${JSON.stringify(script)}\n`;
  // When translating.
  const result = await translate(text);
  // Then exactly one source-located review diagnostic leaves output available.
  expect(result.diagnostics.map(({ kind, keyPath }) => ({ kind, keyPath }))).toEqual([
    { kind: "needs-review", keyPath: ["x-script"] },
  ]);
  expect(result.diagnostics[0]?.sourceId).toBe(ConfigTranslateSourceId.make("source"));
  expect(result.diagnostics[0]?.span?.start.line).toBe(2);
  expect(result.outputs[0]?.fragment).toEqual({ name: "demo", "x-script": script });
});

test.each(["pull", "push", "share"])("blocks legacy %s even alongside review findings", async (verb) => {
  // Given a hoster command mixed with environment references and an ordinary command.
  const text = `name: demo\nx-script: 'echo $LANDO_INFO; lando ${verb} --database dev; lando start'\n`;
  // When translating.
  const result = await translate(text);
  // Then severity wins without duplicating the path.
  expect(result.diagnostics.map(({ kind, keyPath }) => ({ kind, keyPath }))).toEqual([
    { kind: "unsupported", keyPath: ["x-script"] },
  ]);
});

test.each([
  "lando4 pull",
  "lando.example pull",
  "lando-pull",
  "lando_pull",
  "/lando/ pull",
  "/bin/lando pull",
  "LANDO_INFORMATION LANDO_MOUNTS",
  "mylando pull",
])("ignores non-reference %s", async (script) => {
  // Given a lookalike, not a legacy reference.
  const text = `name: demo\nx-script: ${JSON.stringify(script)}\n`;
  // When translating.
  const result = await translate(text);
  // Then it is not diagnosed.
  expect(result.diagnostics).toEqual([]);
});

test("scans nested maps and arrays while leaving tagged values opaque", async () => {
  // Given commands in different lowerer-owned sections plus a tagged extension.
  const text =
    "name: demo\nservices:\n  appserver:\n    type: php:8.3\n    environment:\n      OLD: $LANDO_MOUNT\ntooling:\n  audit:\n    cmd: lando rebuild -s appserver && echo $LANDO_INFO\nevents:\n  post-start: [lando logs -t]\nx-tag: !load lando-pull.txt\n";
  // When translating.
  const result = await translate(text);
  // Then the scanner reaches all three scalar paths.
  expect(
    result.diagnostics
      .filter(({ kind }) => kind === "needs-review")
      .map(({ kind, keyPath }) => ({ kind, keyPath })),
  ).toEqual([
    { kind: "needs-review", keyPath: ["services", "appserver", "type"] },
    { kind: "needs-review", keyPath: ["services", "appserver", "environment", "OLD"] },
    { kind: "needs-review", keyPath: ["tooling", "audit", "cmd"] },
    { kind: "needs-review", keyPath: ["events", "post-start", 0] },
  ]);
});

test("blocks a nested legacy pull invocation", async () => {
  // Given a legacy invocation inside another command's substitution.
  const text = "name: demo\nx-script: 'lando exec echo $(lando pull --database dev)'\n";
  // When translating.
  const result = await translate(text);
  // Then the nested blocking command is not swallowed by the outer command's arguments.
  expect(result.diagnostics.map(({ kind, keyPath }) => ({ kind, keyPath }))).toEqual([
    { kind: "unsupported", keyPath: ["x-script"] },
  ]);
});

test("uses merged scalar provenance and skips identity, global state, and tags", async () => {
  // Given layers with an overridden scalar and concatenated sequence entries.
  const sources = await Promise.all(
    [
      {
        sourceId: ConfigTranslateSourceId.make("base"),
        layer: "base" as const,
        file: ".lando.base.yml",
        content:
          "name: lando pull\nrecipe: lando push\nappEnv: {OLD: LANDO_INFO}\nx-tag: !load 'lando share LANDO_INFO'\nx-map: {cmd: lando start}\nx-list: [lando logs -t]\n",
      },
      {
        sourceId: ConfigTranslateSourceId.make("local"),
        layer: "local" as const,
        file: ".lando.local.yml",
        content: "x-map: {cmd: lando pull}\nx-list: [lando version -a]\n",
      },
    ].map(async ({ content, ...source }) => ({
      ...source,
      value: toMergedValue({
        ...source,
        document: await Effect.runPromise(
          parseLegacyLandofile({ mode: "legacy", file: source.file, content }),
        ),
      }),
    })),
  );
  // When scanning the merged document.
  const diagnostics = legacyReferenceDiagnostics(
    mergeLegacySources(sources),
    ConfigTranslateSourceId.make("fallback"),
  );
  // Then paths use merged indexes while spans and source ids point to authored occurrences.
  expect(
    diagnostics.map(({ kind, keyPath, sourceId, span }) => ({
      kind,
      keyPath,
      sourceId,
      line: span?.start.line,
    })),
  ).toEqual([
    {
      kind: "unsupported",
      keyPath: ["x-map", "cmd"],
      sourceId: ConfigTranslateSourceId.make("local"),
      line: 1,
    },
    { kind: "needs-review", keyPath: ["x-list", 0], sourceId: ConfigTranslateSourceId.make("base"), line: 6 },
    {
      kind: "needs-review",
      keyPath: ["x-list", 1],
      sourceId: ConfigTranslateSourceId.make("local"),
      line: 2,
    },
  ]);
});
