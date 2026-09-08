// allow: SIZE_OK — this task's ownership fence requires all translation regressions in this existing test file.
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Cause, Effect, Exit, Layer, Schema } from "effect";

import { ConfigTranslateError, ConfigTranslatorConflictError } from "@lando/sdk/errors";
import { emitLandofileYaml } from "@lando/sdk/landofile";

import {
  type ConfigTranslateDiagnostic,
  type ConfigTranslateEncodeInput,
  type ConfigTranslateInput,
  ConfigTranslateSourceId,
  type LandofileAuthoringFragmentWire,
} from "@lando/sdk/schema";
import {
  type ConfigTranslateDetectInput,
  ConfigTranslatorRegistry,
  type ConfigTranslatorShape,
} from "@lando/sdk/services";
import { runConfigTranslatorContractSuite } from "@lando/sdk/test";

import { parseLandofile } from "@lando/landofile/parser";
import {
  type AppConfigTranslateResult,
  AppConfigTranslateResultSchema,
  appConfigTranslate,
  renderConfigTranslateResult,
} from "../../src/cli/commands/app-config-translate.ts";

const dirs: Array<string> = [];
const originalDataRoot = process.env.LANDO_USER_DATA_ROOT;

afterEach(async () => {
  if (originalDataRoot === undefined) Reflect.deleteProperty(process.env, "LANDO_USER_DATA_ROOT");
  else process.env.LANDO_USER_DATA_ROOT = originalDataRoot;
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

const makeAppDir = async (landofile: string): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), "lando-translate-"));
  dirs.push(dir);
  process.env.LANDO_USER_DATA_ROOT = join(dir, "journal");
  await Bun.write(join(dir, ".lando.yml"), landofile);
  return dir;
};

interface TranslatorOptions {
  readonly detects?: boolean;
  readonly confidence?: "exact" | "likely" | "possible";
}

const makeTranslator = (
  id: string,
  fragment: typeof LandofileAuthoringFragmentWire.Type,
  options: TranslatorOptions = {},
): ConfigTranslatorShape => ({
  id,
  summary: `${id} translator`,
  inputKinds: ["lando-v3"],
  detect: (input: ConfigTranslateDetectInput) =>
    Effect.succeed(
      options.detects === false || input.documents.length === 0
        ? []
        : [
            {
              translator: id,
              sourceIds: input.documents.map((document) => document.sourceId),
              confidence: options.confidence ?? ("likely" as const),
            },
          ],
    ),
  translate: (input) => {
    const sourceIds =
      input._tag === "recipe-request"
        ? [input.sourceId]
        : input.documents.map((document) => document.sourceId);
    return Effect.succeed({
      outputs: [{ targetLayer: "canonical", fragment, sourceIds }],
      diagnostics: [
        {
          kind: "generated" as const,
          message: `${id} added keys`,
          sourceId: sourceIds[0] ?? ConfigTranslateSourceId.make("missing"),
          keyPath: [],
        },
      ],
      deletions: [],
    });
  },
});

const makeLando4Encoder = (
  diagnostics: readonly ConfigTranslateDiagnostic[] = [],
): ConfigTranslatorShape => ({
  id: "lando4",
  summary: "Encode Landofile",
  inputKinds: ["lando-v4"],
  detect: () => Effect.succeed([]),
  translate: () => Effect.fail(new ConfigTranslateError({ message: "encoder-only" })),
  encode: ({ context, fragment }) =>
    Effect.succeed({
      text: emitLandofileYaml(
        Schema.decodeUnknownSync(Schema.Record({ key: Schema.String, value: Schema.Unknown }))(
          fragment ?? context,
        ),
        { sortKeys: true },
      ),
      diagnostics,
    }),
});
const withEncoder = (list: readonly ConfigTranslatorShape[]) => [...list, makeLando4Encoder()];

const runExit = <A, E>(effect: Effect.Effect<A, E, never>) => Effect.runPromiseExit(effect);

const failureTag = (exit: Exit.Exit<unknown, unknown>): string | undefined => {
  if (!Exit.isFailure(exit)) return undefined;
  const failure = Cause.failureOption(exit.cause);
  return failure._tag === "Some" ? (failure.value as { _tag: string })._tag : undefined;
};

const failureValue = (
  exit: Exit.Exit<unknown, unknown>,
): { _tag: string; message?: string; remediation?: string } | undefined => {
  if (!Exit.isFailure(exit)) return undefined;
  const failure = Cause.failureOption(exit.cause);
  return failure._tag === "Some"
    ? (failure.value as { _tag: string; message?: string; remediation?: string })
    : undefined;
};

describe("appConfigTranslate", () => {
  test("validates each cumulative merge prefix", async () => {
    const cwd = await makeAppDir("name: demo\n");
    const sourceIds = [ConfigTranslateSourceId.make(".lando.yml")];
    const translator: ConfigTranslatorShape = {
      ...makeTranslator("v3", {}),
      translate: () =>
        Effect.succeed({
          outputs: [
            {
              targetLayer: "canonical",
              fragment: { name: "demo", tooling: { echo: { vars: { VALUE: { sh: "echo hi" } } } } },
              sourceIds,
            },
            {
              targetLayer: "local",
              fragment: { tooling: { echo: { vars: { VALUE: { prompt: "Value" } } } } },
              sourceIds,
            },
            { targetLayer: "user", fragment: { tooling: { echo: { vars: { VALUE: "fixed" } } } }, sourceIds },
          ],
          diagnostics: [],
          deletions: [],
        }),
    };
    const exit = await runExit(appConfigTranslate({ cwd, translators: withEncoder([translator]) }));
    expect(failureValue(exit)?.message).toContain("merge prefix");
    expect(failureValue(exit)?.message).toContain("local");
  });
  test.each(["unsupported", "non-portable"] as const)(
    "a %s diagnostic previews but fails --write closed",
    async (kind) => {
      const cwd = await makeAppDir("name: demo\n");
      let calls = 0;
      const base = makeTranslator("v3", { name: "demo" });
      const translator: ConfigTranslatorShape = {
        ...base,
        translate: (input) =>
          base.translate(input).pipe(
            Effect.map((result) => ({
              ...result,
              diagnostics: [
                {
                  kind,
                  sourceId: ConfigTranslateSourceId.make(".lando.yml"),
                  keyPath: [],
                  message: "token=SECRET123",
                },
              ],
            })),
          ),
      };
      const encoder: ConfigTranslatorShape = {
        ...makeLando4Encoder(),
        encode: () => {
          calls++;
          return Effect.succeed({ text: "name: demo\n", diagnostics: [] });
        },
      };
      const result = await Effect.runPromise(appConfigTranslate({ cwd, translators: [translator, encoder] }));
      if (result.mode !== "preview") throw new Error("expected preview");
      expect(calls).toBe(kind === "unsupported" ? 0 : 1);
      expect(result.targets.length).toBe(kind === "unsupported" ? 0 : 1);
      expect(result.content).toBe(kind === "unsupported" ? "" : "name: demo\n");
      const exit = await runExit(
        appConfigTranslate({ cwd, write: true, translators: [translator, encoder] }),
      );
      expect(failureValue(exit)?.message).toContain(kind);
      expect(failureValue(exit)?.message).not.toContain("SECRET123");
      expect(await Bun.file(join(cwd, ".lando.yml")).text()).toBe("name: demo\n");
    },
  );
  test("preview and --write report identical diagnostics", async () => {
    const cwd = await makeAppDir("name: demo\n");
    const translators = [
      makeTranslator("v3", { name: "demo" }),
      makeLando4Encoder([
        {
          kind: "needs-review",
          sourceId: ConfigTranslateSourceId.make(".lando.yml"),
          keyPath: [],
          message: "password=hunter2",
        },
      ]),
    ];
    const preview = await Effect.runPromise(appConfigTranslate({ cwd, translators }));
    const written = await Effect.runPromise(appConfigTranslate({ cwd, write: true, translators }));
    if (preview.mode !== "preview" || written.mode !== "write") throw new Error("expected results");
    expect(written.diagnostics).toEqual(preview.diagnostics);
  });
  test("--write --to non-lando4 fails closed as preview-only", async () => {
    const cwd = await makeAppDir("name: demo\n");
    const exit = await runExit(
      appConfigTranslate({
        cwd,
        write: true,
        to: "custom",
        translators: [makeTranslator("v3", { name: "demo" }), { ...makeLando4Encoder(), id: "custom" }],
      }),
    );
    expect(failureValue(exit)?.message).toContain("preview-only");
  });
  test("single-layer fails closed when a lower layer is not v4", async () => {
    const cwd = await makeAppDir('recipe: lamp\nconfig:\n  php: "7.4"\n');
    await Bun.write(join(cwd, ".lando.local.yml"), "services: {}\n");
    const exit = await runExit(
      appConfigTranslate({
        cwd,
        files: [".lando.local.yml"],
        translators: withEncoder([makeTranslator("v3", { name: "demo" })]),
      }),
    );
    expect(failureValue(exit)?.message).toContain(".lando.yml is not a v4 Landofile fragment");
  });
  test("single-layer --write fails closed when the target file exists and is not selected", async () => {
    const original = "name: original\n";
    const cwd = await makeAppDir(original);
    await Bun.write(join(cwd, "docker-compose.yml"), "services: {}\n");
    const exit = await runExit(
      appConfigTranslate({
        cwd,
        write: true,
        files: ["docker-compose.yml"],
        translators: withEncoder([makeTranslator("v3", { name: "demo" })]),
      }),
    );
    expect(failureValue(exit)?.remediation).toContain("--file .lando.yml");
    expect(await Bun.file(join(cwd, ".lando.yml")).text()).toBe(original);
  });
  test("single-layer deletion naming a non-selected source fails closed", async () => {
    const cwd = await makeAppDir("name: demo\n");
    await Bun.write(join(cwd, "docker-compose.yml"), "services: {}\n");
    const base = makeTranslator("v3", { name: "demo" });
    const translator: ConfigTranslatorShape = {
      ...base,
      translate: (input) =>
        base.translate(input).pipe(
          Effect.map((result) => ({
            ...result,
            deletions: [{ sourceId: ConfigTranslateSourceId.make("docker-compose.yml") }],
          })),
        ),
    };
    const exit = await runExit(
      appConfigTranslate({ cwd, write: true, files: [".lando.yml"], translators: withEncoder([translator]) }),
    );
    expect(failureValue(exit)?.remediation).toContain("--file docker-compose.yml");
    expect(existsSync(join(cwd, "docker-compose.yml"))).toBe(true);
  });
  test("a failed transaction leaves every target at its original bytes", async () => {
    const original = "name: original\n";
    const cwd = await makeAppDir(original);
    await mkdir(join(cwd, ".lando.local.yml"));
    const sourceIds = [ConfigTranslateSourceId.make(".lando.yml")];
    const translator: ConfigTranslatorShape = {
      ...makeTranslator("v3", {}),
      translate: () =>
        Effect.succeed({
          outputs: [
            { targetLayer: "canonical", fragment: { name: "demo" }, sourceIds },
            { targetLayer: "local", fragment: { runtime: 4 }, sourceIds },
          ],
          diagnostics: [],
          deletions: [],
        }),
    };
    const exit = await runExit(
      appConfigTranslate({ cwd, write: true, translators: withEncoder([translator]) }),
    );
    expect(failureTag(exit)).toBe("ConfigTranslateError");
    expect(failureValue(exit)?.message).toContain("prepare");
    expect(await Bun.file(join(cwd, ".lando.yml")).text()).toBe(original);
    expect((await readdir(cwd)).filter((path) => path.includes(".lando-stage."))).toEqual([]);
  });
  test("--write writes each declared layer through the managed-file transaction", async () => {
    const cwd = await makeAppDir("name: original\n");
    const sourceIds = [ConfigTranslateSourceId.make(".lando.yml")];
    const translator: ConfigTranslatorShape = {
      ...makeTranslator("v3", {}),
      translate: () =>
        Effect.succeed({
          outputs: [
            { targetLayer: "canonical", fragment: { name: "demo" }, sourceIds },
            { targetLayer: "local", fragment: { runtime: 4 }, sourceIds },
          ],
          diagnostics: [],
          deletions: [],
        }),
    };
    const result = await Effect.runPromise(
      appConfigTranslate({ cwd, write: true, translators: withEncoder([translator]) }),
    );
    if (result.mode !== "write") throw new Error("expected write");
    expect([...result.written].sort()).toEqual([join(cwd, ".lando.local.yml"), join(cwd, ".lando.yml")]);
    expect(result.backups).toHaveLength(1);
    expect(result.backups[0]).toMatch(/\.lando\.yml\.bak\.[0-9a-f]{64}$/);
    expect(existsSync(join(cwd, ".lando.yml.bak"))).toBe(false);
    expect(await Bun.file(join(cwd, ".lando.yml")).text()).toBe("name: demo\n");
    expect(await Bun.file(join(cwd, ".lando.local.yml")).text()).toBe("runtime: 4\n");
  });
  test("orders frontend diagnostics before encoder diagnostics and redacts both", async () => {
    const cwd = await makeAppDir("name: demo\n");
    const sourceId = ConfigTranslateSourceId.make(".lando.yml");
    const front = {
      kind: "generated",
      sourceId,
      keyPath: [],
      message: "token=SECRET123",
      remediation: "password=hunter2",
    } as const;
    const back = {
      kind: "rewritten",
      sourceId,
      keyPath: [],
      message: "password=hunter2",
      remediation: "token=SECRET123",
    } as const;
    const base = makeTranslator("v3", { name: "demo" });
    const translator: ConfigTranslatorShape = {
      ...base,
      translate: (input) =>
        base.translate(input).pipe(Effect.map((result) => ({ ...result, diagnostics: [front] }))),
    };
    const result = await Effect.runPromise(
      appConfigTranslate({ cwd, translators: [translator, makeLando4Encoder([back])] }),
    );
    if (result.mode !== "preview") throw new Error("expected preview");
    expect(result.diagnostics.map((d) => d.message)).toEqual(["token=[redacted]", "password=[redacted]"]);
    expect(result.diagnostics.map((d) => d.remediation)).toEqual(["password=[redacted]", "token=[redacted]"]);
  });
  test("fails closed before encoding when an output is not valid authoring data", async () => {
    const invalidAuthoringFragment = (): typeof LandofileAuthoringFragmentWire.Type => {
      const fragment: typeof LandofileAuthoringFragmentWire.Type = {};
      Reflect.set(fragment, "notALandofileKey", true);
      return fragment;
    };
    // Authoring validation runs ahead of the target encoder, so a bad output
    // never reaches an encoder and never reaches a file.
    const cwd = await makeAppDir("name: demo\n");
    let encoded = 0;
    const encoder = makeLando4Encoder();
    const counting = {
      ...encoder,
      encode: (input: Parameters<NonNullable<typeof encoder.encode>>[0]) => {
        encoded += 1;
        return encoder.encode?.(input) ?? Effect.die("missing encoder");
      },
    };
    const exit = await runExit(
      appConfigTranslate({ cwd, translators: [makeTranslator("v3", invalidAuthoringFragment()), counting] }),
    );
    expect(failureValue(exit)?._tag).toBe("ConfigTranslateError");
    expect(encoded).toBe(0);
  });
  test.each(["missing", "v3"])("--to %s without an encoder fails closed", async (to) => {
    const cwd = await makeAppDir("name: demo\n");
    const exit = await runExit(
      appConfigTranslate({
        cwd,
        to,
        translators: withEncoder([makeTranslator("v3", { name: "demo" })]),
      }),
    );
    expect(failureValue(exit)?.message).toContain("--to");
    expect(failureValue(exit)?.remediation).toContain("lando4");
  });
  test("encodes every output through the --to target encoder", async () => {
    const cwd = await makeAppDir("name: old\n");
    const inputs: ConfigTranslateEncodeInput[] = [];
    const canonical = { name: "demo", runtime: 4 } as const;
    const local = { services: { web: { port: "{{ env.PORT }}" } } };
    const translator: ConfigTranslatorShape = {
      ...makeTranslator("v3", canonical),
      translate: () =>
        Effect.succeed({
          outputs: [
            {
              targetLayer: "local",
              fragment: local,
              sourceIds: [ConfigTranslateSourceId.make(".lando.yml")],
            },
            {
              targetLayer: "canonical",
              fragment: canonical,
              sourceIds: [ConfigTranslateSourceId.make(".lando.yml")],
            },
          ],
          diagnostics: [],
          deletions: [],
        }),
    };
    const encoder: ConfigTranslatorShape = {
      ...makeLando4Encoder(),
      id: "custom",
      encode: (input) => {
        inputs.push(input);
        return Effect.succeed({ text: "encoded\n", diagnostics: [] });
      },
    };
    const result = await Effect.runPromise(
      appConfigTranslate({ cwd, to: "custom", translators: [translator, encoder] }),
    );
    expect(inputs).toEqual([
      { context: { ...canonical, ...local }, fragment: canonical },
      { context: { ...canonical, ...local }, fragment: local },
    ]);
    expect(inputs[0]?.context).toBe(inputs[1]?.context);
    if (result.mode !== "preview") throw new Error("expected preview");
    expect(result.targets).toEqual([
      { layer: "canonical", path: join(cwd, ".lando.yml"), content: "encoded\n" },
      { layer: "local", path: join(cwd, ".lando.local.yml"), content: "encoded\n" },
    ]);
  });
  test("translates a non-v4 canonical Landofile without predecoding it", async () => {
    const cwd = await makeAppDir('recipe: lamp\nconfig:\n  php: "7.4"\n');
    const result = await Effect.runPromise(
      appConfigTranslate({
        cwd,
        translators: withEncoder([makeTranslator("v3", { name: "demo", runtime: 4 })]),
      }),
    );
    if (result.mode !== "preview") throw new Error("expected preview");
    expect(result.content).toContain("name: demo");
    expect(result.content).not.toContain("config");
  });
  test("--file switches to single-layer mode with lower v4 layers as context", async () => {
    const cwd = await makeAppDir("name: demo\nruntime: 4\n");
    await Bun.write(join(cwd, ".lando.local.yml"), "services: {}\n");
    const inputs: ConfigTranslateInput[] = [];
    const translator: ConfigTranslatorShape = {
      ...makeTranslator("v3", {}),
      translate: (input) => {
        inputs.push(input);
        return Effect.succeed({
          outputs: [
            {
              targetLayer: "local",
              fragment: {},
              sourceIds: [ConfigTranslateSourceId.make(".lando.local.yml")],
            },
          ],
          diagnostics: [],
          deletions: [],
        });
      },
    };
    await Effect.runPromise(
      appConfigTranslate({ cwd, files: [".lando.local.yml"], translators: withEncoder([translator]) }),
    );
    const input = inputs[0];
    if (input?._tag !== "landofile-document-set") throw new Error("expected document set");
    expect(input.mode).toBe("single-layer");
    expect(input.selectedSourceIds.map(String)).toEqual([".lando.local.yml"]);
    expect(input.writableLayerIds).toEqual(["local"]);
    expect(input.currentLowerV4Fragments).toEqual([
      { layerId: "canonical", fragment: { name: "demo", runtime: 4 } },
    ]);
    expect(input.documents.map((d) => String(d.sourceId))).toEqual([".lando.yml", ".lando.local.yml"]);
  });
  test("invokes the frontend once with the canonically ordered full document set", async () => {
    // Given: canonical, foreign and local source documents.
    const cwd = await makeAppDir("name: demo\nruntime: 4\n");
    await Bun.write(join(cwd, ".lando.local.yml"), "services: {}\n");
    await Bun.write(join(cwd, "docker-compose.yml"), "services: {}\n");
    const inputs: ConfigTranslateInput[] = [];
    const base = makeTranslator("v3", { name: "demo", runtime: 4 });
    // When: translating the full set.
    await Effect.runPromise(
      appConfigTranslate({
        cwd,
        translators: withEncoder([
          {
            ...base,
            translate: (input) => {
              inputs.push(input);
              return base.translate(input);
            },
          },
        ]),
      }),
    );
    // Then: one canonically ordered request owns all layers.
    expect(inputs).toHaveLength(1);
    const input = inputs[0];
    if (input?._tag !== "landofile-document-set") throw new Error("expected document set");
    expect(input.documents.map((d) => String(d.sourceId))).toEqual([
      ".lando.yml",
      "docker-compose.yml",
      ".lando.local.yml",
    ]);
    expect(input.documents.map((d) => d.layerId)).toEqual(["canonical", "canonical", "local"]);
    expect(input.mode).toBe("full");
    expect(input.writableLayerIds).toEqual(["base", "dist", "upstream", "canonical", "local", "user"]);
    expect(input.currentLowerV4Fragments).toEqual([]);
  });
  test.each(["generated", "dropped", "rewritten", "unsupported", "non-portable", "needs-review"] as const)(
    "renders source-attributed %s diagnostics in preview and write results",
    (kind) => {
      const sourceId = ConfigTranslateSourceId.make("compose.yml");
      const diagnostics = [{ kind, sourceId, keyPath: ["services", "web", 0], message: "Changed" }];
      const deletions = [{ sourceId }];
      const results: readonly AppConfigTranslateResult[] = [
        { mode: "list", translators: [] },
        {
          mode: "detect",
          inputPath: ".lando.yml",
          files: [sourceId],
          matches: [{ translator: "compose", sourceIds: [sourceId], confidence: "exact" }],
        },
        {
          mode: "preview",
          inputPath: ".lando.yml",
          files: [sourceId],
          translator: "compose",
          target: "lando4",
          targets: [{ layer: "canonical", path: ".lando.yml", content: "name: demo\n" }],
          content: "name: demo\n",
          diagnostics,
          deletions,
        },
        {
          mode: "write",
          inputPath: ".lando.yml",
          target: "lando4",
          written: [".lando.yml"],
          backups: [],
          removed: [],
          diagnostics,
          deletions,
        },
      ];
      const glyphs = {
        generated: "+",
        dropped: "-",
        rewritten: "~",
        unsupported: "!",
        "non-portable": "~",
        "needs-review": "?",
      };
      for (const result of results) {
        expect(Schema.encodeSync(AppConfigTranslateResultSchema)(result).mode).toBe(result.mode);
        if (result.mode === "preview" || result.mode === "write") {
          const text = renderConfigTranslateResult(result);
          expect(text).toContain(`# ${glyphs[kind]} Changed (compose.yml:services.web.0)`);
          expect(text).toContain("# deletions: compose.yml");
        }
      }
    },
  );
  // Selection narrows write ownership, not the immutable document snapshots.
  test("passes bounded byte snapshots and single-layer ownership when previewing", async () => {
    const cwd = await makeAppDir("name: demo\n");
    const bytes = new TextEncoder().encode("services: {}\n");
    await Bun.write(join(cwd, "docker-compose.yml"), bytes);
    const inputs: ConfigTranslateInput[] = [];
    const base = makeTranslator("compose", { name: "demo" });
    await Effect.runPromise(
      appConfigTranslate({
        cwd,
        files: ["docker-compose.yml"],
        translators: withEncoder([
          {
            ...base,
            translate: (input) => {
              inputs.push(input);
              return base.translate(input);
            },
          },
        ]),
      }),
    );
    expect<unknown>(inputs).toEqual([
      {
        _tag: "landofile-document-set",
        documents: [
          {
            sourceId: ".lando.yml",
            path: ".lando.yml",
            layerId: "canonical",
            mediaType: "application/yaml",
            contentDigest: `sha256:${new Bun.CryptoHasher("sha256").update("name: demo\n").digest("hex")}`,
            bytes: new TextEncoder().encode("name: demo\n"),
          },
          {
            sourceId: "docker-compose.yml",
            path: "docker-compose.yml",
            layerId: "canonical",
            mediaType: "application/yaml",
            contentDigest: `sha256:${new Bun.CryptoHasher("sha256").update(bytes).digest("hex")}`,
            bytes,
          },
        ],
        mode: "single-layer",
        selectedSourceIds: ["docker-compose.yml"],
        currentLowerV4Fragments: [],
        writableLayerIds: ["canonical"],
      },
    ]);
  });

  // Frontends supply complete authoring values; core never merges raw input.
  test("preserves unresolved typed expressions when merging authoring fragments", async () => {
    const cwd = await makeAppDir('name: demo\nrouter:\n  enabled: "{{ env.ENABLED }}"\n');
    const result = await Effect.runPromise(
      appConfigTranslate({
        cwd,
        translators: withEncoder([
          makeTranslator("v3", { name: "demo", services: { web: { port: "{{ env.PORT }}" } } }),
        ]),
      }),
    );
    expect(result.mode).toBe("preview");
    if (result.mode === "preview") expect(result.content).toContain('port: "{{ env.PORT }}"');
  });

  // Explicit canonical selection makes local output genuinely unowned.
  test("rejects output to an unwritable layer", async () => {
    const cwd = await makeAppDir("name: demo\n");
    const translator = {
      ...makeTranslator("v3", {}),
      translate: () =>
        Effect.succeed({
          outputs: [
            {
              targetLayer: "local" as const,
              fragment: {},
              sourceIds: [ConfigTranslateSourceId.make(".lando.yml")],
            },
          ],
          diagnostics: [],
          deletions: [],
        }),
    };
    expect(
      failureTag(
        await runExit(
          appConfigTranslate({ cwd, files: [".lando.yml"], translators: withEncoder([translator]) }),
        ),
      ),
    ).toBe("ConfigTranslateError");
  });

  test("deletions are removed in the same transaction", async () => {
    const original = "name: demo\n";
    const cwd = await makeAppDir(original);
    await Bun.write(join(cwd, "docker-compose.yml"), "services: {}\n");
    const translator = {
      ...makeTranslator("v3", {}),
      translate: () =>
        Effect.succeed({
          outputs: [
            {
              targetLayer: "canonical" as const,
              fragment: { name: "demo" },
              sourceIds: [ConfigTranslateSourceId.make(".lando.yml")],
            },
          ],
          diagnostics: [],
          deletions: [{ sourceId: ConfigTranslateSourceId.make("docker-compose.yml") }],
        }),
    };
    const result = await Effect.runPromise(
      appConfigTranslate({ cwd, write: true, translators: withEncoder([translator]) }),
    );
    if (result.mode !== "write") throw new Error("expected write");
    expect(result.removed).toEqual([join(cwd, "docker-compose.yml")]);
    expect(existsSync(join(cwd, "docker-compose.yml"))).toBe(false);
    const backup = join(
      cwd,
      `docker-compose.yml.bak.${new Bun.CryptoHasher("sha256").update("services: {}\n").digest("hex")}`,
    );
    expect(result.backups).toContain(backup);
    expect(await Bun.file(backup).text()).toBe("services: {}\n");
    expect(await Bun.file(join(cwd, ".lando.yml")).text()).toBe(original);
    expect(existsSync(join(cwd, ".lando.yml.bak"))).toBe(false);
  });

  test.each([false, true])("bounds oversized documents with explicit=%s", async (explicit) => {
    const cwd = await makeAppDir("name: demo\n");
    await Bun.write(join(cwd, "large.json"), new Uint8Array(1_048_577));
    const exit = await runExit(
      appConfigTranslate({
        cwd,
        detect: true,
        translators: withEncoder([makeTranslator("v3", {})]),
        ...(explicit ? { files: ["large.json"] } : {}),
      }),
    );
    if (explicit) {
      expect(failureTag(exit)).toBe("ConfigTranslateError");
      expect(failureValue(exit)?.remediation).toBeTruthy();
    } else {
      expect(Exit.isSuccess(exit)).toBe(true);
      if (Exit.isSuccess(exit) && exit.value.mode === "detect")
        expect(exit.value.files).toEqual([".lando.yml"]);
    }
  });
  // Preview is the target encoder's complete frontend output, not raw-input merging.
  test("previews the canonical Landofile without writing by default", async () => {
    const cwd = await makeAppDir("name: demo\nruntime: 4\n");
    const translators = withEncoder([
      makeTranslator("v3", { name: "demo", runtime: 4, services: { db: { type: "mysql:8.0" } } }),
    ]);
    const result = await Effect.runPromise(appConfigTranslate({ cwd, translators }));
    expect(result.mode).toBe("preview");
    if (result.mode !== "preview") throw new Error("expected preview mode");
    expect(result.translator).toBe("v3");
    expect(result.target).toBe("lando4");
    expect(result.targets[0]?.path).toBe(join(cwd, ".lando.yml"));
    expect(result.content).toContain("name: demo");
    expect(result.content).toContain("db");
    expect(result.diagnostics.length).toBe(1);

    expect(existsSync(join(cwd, ".lando.yml.canonical"))).toBe(false);

    const parsed = (await Effect.runPromise(
      parseLandofile({ file: join(cwd, ".lando.yml"), content: result.content, cwd }),
    )) as Record<string, unknown>;
    expect(parsed).toEqual({
      name: "demo",
      runtime: 4,
      services: { db: { type: "mysql:8.0" } },
    });

    const input = await readFile(join(cwd, ".lando.yml"), "utf8");
    expect(input).toBe("name: demo\nruntime: 4\n");
  });

  test("--list enumerates registered translators, id and source format", async () => {
    const translators = [
      makeTranslator("v3", { services: { db: { type: "mysql:8.0" } } }),
      makeTranslator("compose", {}),
    ];
    const result = await Effect.runPromise(appConfigTranslate({ list: true, translators }));
    expect(result.mode).toBe("list");
    if (result.mode !== "list") throw new Error("expected list mode");
    expect(result.translators.map((t) => t.id)).toEqual(["v3", "compose"]);
    expect(result.translators[0]?.inputKinds).toEqual(["lando-v3"]);
    expect(result.translators[0]?.summary).toBe("v3 translator");
  });

  test("resolves translators from ConfigTranslatorRegistry when none are injected", async () => {
    // Given: a runtime whose registry lists two translators in plugin order.
    const translators = [
      makeTranslator("v3", { services: { db: { type: "mysql:8.0" } } }),
      makeTranslator("compose", {}),
    ];
    const registry = Layer.succeed(ConfigTranslatorRegistry, { list: Effect.succeed(translators) });

    // When: the operation lists without an explicit translators option.
    const result = await Effect.runPromise(appConfigTranslate({ list: true }).pipe(Effect.provide(registry)));

    // Then: the registry supplies the translators.
    expect(result.mode).toBe("list");
    if (result.mode !== "list") throw new Error("expected list mode");
    expect(result.translators.map((t) => t.id)).toEqual(["v3", "compose"]);
  });

  test("surfaces a registry collision as the tagged conflict error", async () => {
    // Given: a registry whose listing fails on duplicate ids.
    const conflict = new ConfigTranslatorConflictError({
      message: "duplicate",
      id: "lando3",
      translators: ["@lando/lando3", "@acme/lando3-fork"],
    });
    const registry = Layer.succeed(ConfigTranslatorRegistry, { list: Effect.fail(conflict) });

    // When: the operation lists.
    const exit = await Effect.runPromiseExit(
      appConfigTranslate({ list: true }).pipe(Effect.provide(registry)),
    );

    // Then: the collision propagates untouched.
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const error = Cause.failureOption(exit.cause);
      expect(error._tag).toBe("Some");
      if (error._tag === "Some") expect(error.value).toBe(conflict);
    }
  });

  test("--list with no registered translators returns an empty list, not an error", async () => {
    const result = await Effect.runPromise(appConfigTranslate({ list: true }));
    expect(result.mode).toBe("list");
    if (result.mode !== "list") throw new Error("expected list mode");
    expect(result.translators).toEqual([]);
  });

  test("--detect reports translator matches without translating", async () => {
    const cwd = await makeAppDir("name: demo\nruntime: 4\n");
    let translated = false;
    const translators: ReadonlyArray<ConfigTranslatorShape> = [
      {
        ...makeTranslator("v3", {}),
        translate: () =>
          Effect.sync(() => {
            translated = true;
            return { outputs: [], diagnostics: [], deletions: [] };
          }),
      },
    ];

    const result = await Effect.runPromise(appConfigTranslate({ cwd, detect: true, translators }));

    expect(result.mode).toBe("detect");
    if (result.mode !== "detect") throw new Error("expected detect mode");
    expect(result.matches).toEqual([
      { translator: "v3", sourceIds: [ConfigTranslateSourceId.make(".lando.yml")], confidence: "likely" },
    ]);
    expect(translated).toBe(false);
    expect(renderConfigTranslateResult(result, "table")).toContain("v3\tlikely");
  });

  test("autodetection discovers in-root symlinked source files", async () => {
    const cwd = await makeAppDir("name: demo\nruntime: 4\n");
    await mkdir(join(cwd, "compose"), { recursive: true });
    await Bun.write(join(cwd, "compose", "docker-compose.yml"), "services: {}\n");
    await symlink(join(cwd, "compose", "docker-compose.yml"), join(cwd, "docker-compose.yml"));

    const translators = withEncoder([makeTranslator("compose", {})]);
    const result = await Effect.runPromise(appConfigTranslate({ cwd, detect: true, translators }));

    expect(result.mode).toBe("detect");
    if (result.mode !== "detect") throw new Error("expected detect mode");
    expect(result.files).toContain("docker-compose.yml");
  });

  test("autodetection skips source files whose real path escapes the app root", async () => {
    const cwd = await makeAppDir("name: demo\nruntime: 4\n");
    const targetDir = await mkdtemp(join(tmpdir(), "lando-translate-symlink-target-"));
    dirs.push(targetDir);
    const targetFile = join(targetDir, "docker-compose.yml");
    await Bun.write(targetFile, "services: {}\n");
    await symlink(targetFile, join(cwd, "docker-compose.yml"));

    const translators = withEncoder([makeTranslator("compose", {})]);
    const result = await Effect.runPromise(appConfigTranslate({ cwd, detect: true, translators }));

    expect(result.mode).toBe("detect");
    if (result.mode !== "detect") throw new Error("expected detect mode");
    expect(result.files).not.toContain("docker-compose.yml");
  });

  test("autodetection prunes node_modules, .git, vendor and tmp trees", async () => {
    const cwd = await makeAppDir("name: demo\nruntime: 4\n");
    await mkdir(join(cwd, "node_modules", "some-dep"), { recursive: true });
    await Bun.write(join(cwd, "node_modules", "some-dep", "docker-compose.yml"), "services: {}\n");
    await mkdir(join(cwd, ".git", "objects"), { recursive: true });
    await Bun.write(join(cwd, ".git", "objects", "compose.yml"), "services: {}\n");
    await mkdir(join(cwd, "vendor", "pkg"), { recursive: true });
    await Bun.write(join(cwd, "vendor", "pkg", "docker-compose.yml"), "services: {}\n");
    await mkdir(join(cwd, "tmp"), { recursive: true });
    await Bun.write(join(cwd, "tmp", "docker-compose.yml"), "services: {}\n");
    await Bun.write(join(cwd, "docker-compose.yml"), "services: {}\n");

    const translators = withEncoder([makeTranslator("compose", {})]);
    const result = await Effect.runPromise(appConfigTranslate({ cwd, detect: true, translators }));

    expect(result.mode).toBe("detect");
    if (result.mode !== "detect") throw new Error("expected detect mode");
    expect(result.files).toEqual([".lando.yml", "docker-compose.yml"]);
  });

  test("--from forces a specific translator", async () => {
    const cwd = await makeAppDir("name: demo\nruntime: 4\n");
    const translators = withEncoder([
      makeTranslator("v3", { name: "demo", services: { db: { type: "mysql:8.0" } } }),
      makeTranslator("compose", { name: "demo", services: { cache: { type: "redis:7" } } }),
    ]);
    const result = await Effect.runPromise(appConfigTranslate({ cwd, from: "v3", translators }));
    expect(result.mode).toBe("preview");
    if (result.mode !== "preview") throw new Error("expected preview mode");
    expect(result.translator).toBe("v3");
    expect(result.content).toContain("db");
    expect(result.content).not.toContain("cache");
  });

  test("--from with an unknown id fails with remediation listing available translators", async () => {
    const cwd = await makeAppDir("name: demo\nruntime: 4\n");
    const translators = withEncoder([makeTranslator("v3", {}), makeTranslator("compose", {})]);
    const exit = await runExit(appConfigTranslate({ cwd, from: "nope", translators }));
    expect(Exit.isFailure(exit)).toBe(true);
    expect(failureTag(exit)).toBe("ConfigTranslateError");
    const remediation = failureValue(exit)?.remediation ?? "";
    expect(remediation).toContain("v3");
    expect(remediation).toContain("compose");
  });

  test("--file scopes translator input", async () => {
    const cwd = await makeAppDir("name: demo\nruntime: 4\n");
    await Bun.write(join(cwd, "docker-compose.yml"), "services: {}\n");
    const translators = withEncoder([
      makeTranslator("v3", { name: "demo", services: { db: { type: "mysql:8.0" } } }),
    ]);
    const result = await Effect.runPromise(
      appConfigTranslate({ cwd, files: ["docker-compose.yml"], translators }),
    );
    expect(result.mode).toBe("preview");
    if (result.mode !== "preview") throw new Error("expected preview mode");
    expect(result.files).toContain("docker-compose.yml");
  });

  test("--file accepts ./prefixed discovered paths", async () => {
    const cwd = await makeAppDir("name: demo\nruntime: 4\n");
    await Bun.write(join(cwd, ".lando.local.yml"), "services: {}\n");
    const inputs: ConfigTranslateInput[] = [];
    const translator: ConfigTranslatorShape = {
      ...makeTranslator("v3", {}),
      translate: (input) => {
        inputs.push(input);
        return Effect.succeed({
          outputs: [
            {
              targetLayer: "local",
              fragment: {},
              sourceIds: [ConfigTranslateSourceId.make(".lando.local.yml")],
            },
          ],
          diagnostics: [],
          deletions: [],
        });
      },
    };
    const result = await Effect.runPromise(
      appConfigTranslate({ cwd, files: ["./.lando.local.yml"], translators: withEncoder([translator]) }),
    );
    expect(result.mode).toBe("preview");
    const input = inputs[0];
    if (input?._tag !== "landofile-document-set") throw new Error("expected document set");
    expect(input.selectedSourceIds.map(String)).toEqual([".lando.local.yml"]);
  });

  test("--file rejects paths outside the app root", async () => {
    const cwd = await makeAppDir("name: demo\nruntime: 4\n");
    const translators = withEncoder([makeTranslator("v3", {})]);

    const absoluteExit = await runExit(appConfigTranslate({ cwd, files: ["/tmp/compose.yml"], translators }));
    expect(Exit.isFailure(absoluteExit)).toBe(true);
    expect(failureTag(absoluteExit)).toBe("ConfigTranslateError");
    expect(failureValue(absoluteExit)?.message ?? "").toContain("inside the app root");

    const traversalExit = await runExit(appConfigTranslate({ cwd, files: ["../compose.yml"], translators }));
    expect(Exit.isFailure(traversalExit)).toBe(true);
    expect(failureTag(traversalExit)).toBe("ConfigTranslateError");
    expect(failureValue(traversalExit)?.message ?? "").toContain("inside the app root");

    const targetDir = await mkdtemp(join(tmpdir(), "lando-translate-symlink-file-"));
    dirs.push(targetDir);
    const targetFile = join(targetDir, "docker-compose.yml");
    await Bun.write(targetFile, "services: {}\n");
    await symlink(targetFile, join(cwd, "docker-compose.yml"));
    const symlinkExit = await runExit(
      appConfigTranslate({ cwd, files: ["docker-compose.yml"], translators }),
    );
    expect(Exit.isFailure(symlinkExit)).toBe(true);
    expect(failureTag(symlinkExit)).toBe("ConfigTranslateError");
    expect(failureValue(symlinkExit)?.message ?? "").toContain("inside the app root");

    await mkdir(join(targetDir, "nested"), { recursive: true });
    await Bun.write(join(targetDir, "nested", "compose.yml"), "services: {}\n");
    await symlink(targetDir, join(cwd, "linked"));
    const parentExit = await runExit(
      appConfigTranslate({ cwd, files: ["linked/nested/compose.yml"], translators }),
    );
    expect(Exit.isFailure(parentExit)).toBe(true);
    expect(failureTag(parentExit)).toBe("ConfigTranslateError");
    expect(failureValue(parentExit)?.message ?? "").toContain("inside the app root");
  });

  test("ambiguous autodetection fails with remediation listing --from choices", async () => {
    const cwd = await makeAppDir("name: demo\nruntime: 4\n");
    const translators = withEncoder([
      makeTranslator("v3", { services: { db: { type: "mysql:8.0" } } }),
      makeTranslator("compose", { services: { cache: { type: "redis:7" } } }),
    ]);
    const exit = await runExit(appConfigTranslate({ cwd, translators }));
    expect(Exit.isFailure(exit)).toBe(true);
    expect(failureTag(exit)).toBe("ConfigTranslateError");
    const remediation = failureValue(exit)?.remediation ?? "";
    expect(remediation).toContain("v3");
    expect(remediation).toContain("compose");
  });

  test("autodetection with no matching translator fails with remediation", async () => {
    const cwd = await makeAppDir("name: demo\nruntime: 4\n");
    const translators = withEncoder([makeTranslator("v3", {}, { detects: false })]);
    const exit = await runExit(appConfigTranslate({ cwd, translators }));
    expect(Exit.isFailure(exit)).toBe(true);
    expect(failureTag(exit)).toBe("ConfigTranslateError");
    expect(failureValue(exit)?.remediation ?? "").toContain("--from");
  });

  test("fails with a plugin-install remediation when no translators are registered", async () => {
    const cwd = await makeAppDir("name: demo\nruntime: 4\n");
    const exit = await runExit(appConfigTranslate({ cwd }));
    expect(Exit.isFailure(exit)).toBe(true);
    expect(failureTag(exit)).toBe("ConfigTranslateNoTranslatorsError");
    expect(failureValue(exit)?.remediation ?? "").toContain("plugin");
  });

  test("--write overwrites the input and keeps a digest-named backup of the original", async () => {
    const original = "name: demo\nruntime: 4\n";
    const cwd = await makeAppDir(original);
    const translators = withEncoder([
      makeTranslator("v3", { name: "demo", runtime: 4, services: { cache: { type: "redis:7" } } }),
    ]);
    const result = await Effect.runPromise(appConfigTranslate({ cwd, write: true, translators }));
    expect(result.mode).toBe("write");
    if (result.mode !== "write") throw new Error("expected write mode");
    expect(result.written).toEqual([join(cwd, ".lando.yml")]);
    const backupPath = join(
      cwd,
      `.lando.yml.bak.${new Bun.CryptoHasher("sha256").update(original).digest("hex")}`,
    );
    expect(result.backups[0]).toBe(backupPath);

    const backup = await readFile(backupPath, "utf8");
    expect(backup).toBe(original);

    const written = await readFile(join(cwd, ".lando.yml"), "utf8");
    const parsed = (await Effect.runPromise(
      parseLandofile({ file: join(cwd, ".lando.yml"), content: written, cwd }),
    )) as Record<string, unknown>;
    expect(parsed).toEqual({
      name: "demo",
      runtime: 4,
      services: { cache: { type: "redis:7" } },
    });
  });

  // Unsupported tooling is checked on merged frontend output, never foreign input.
  test("rejects unsupported tooling flag metadata after translation", async () => {
    const cwd = await makeAppDir("name: demo\n");
    const translators = withEncoder([
      makeTranslator("v3", {
        name: "demo",
        runtime: 4,
        tooling: { echo: { cmd: "echo hi", flags: { verbose: { type: "boolean" } } } },
      }),
    ]);

    const exit = await runExit(appConfigTranslate({ cwd, translators }));

    expect(Exit.isFailure(exit)).toBe(true);
    expect(failureTag(exit)).toBe("NotImplementedError");
    expect(failureValue(exit)?.message ?? "").toContain('Tooling flags field "type"');
  });

  test("fails with LandofileNotFoundError when there is no Landofile", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lando-translate-empty-"));
    dirs.push(dir);
    const exit = await runExit(appConfigTranslate({ cwd: dir, translators: [makeTranslator("v3", {})] }));
    expect(Exit.isFailure(exit)).toBe(true);
    expect(failureTag(exit)).toBe("LandofileNotFoundError");
  });

  // Rendering consumes encoder output from a complete frontend fragment.
  test("renderConfigTranslateResult prints the Landofile and the schema encodes each mode", async () => {
    const cwd = await makeAppDir("name: demo\nruntime: 4\n");
    const translators = withEncoder([
      makeTranslator("v3", { name: "demo", services: { db: { type: "mysql:8.0" } } }),
    ]);
    const result = await Effect.runPromise(appConfigTranslate({ cwd, translators }));
    const text = renderConfigTranslateResult(result, "yaml");
    expect(text).toContain("name: demo");
    const encoded = Schema.encodeSync(AppConfigTranslateResultSchema)(result);
    expect(encoded.mode).toBe("preview");

    const listResult = await Effect.runPromise(appConfigTranslate({ list: true, translators }));
    const listText = renderConfigTranslateResult(listResult, "table");
    expect(listText).toContain("v3");
    expect(Schema.encodeSync(AppConfigTranslateResultSchema)(listResult).mode).toBe("list");

    const emptyList = await Effect.runPromise(appConfigTranslate({ list: true }));
    expect(renderConfigTranslateResult(emptyList, "table")).toContain("No config translators");
  });
});

describe("appConfigTranslate contract-suite fixtures", () => {
  const COMPOSE_FILE = ConfigTranslateSourceId.make("docker-compose.yml");
  const documents = [
    {
      sourceId: COMPOSE_FILE,
      layerId: "canonical",
      mediaType: "application/yaml",
      contentDigest: `sha256:${new Bun.CryptoHasher("sha256").update("services: {}\n").digest("hex")}`,
      bytes: new TextEncoder().encode("services: {}\n"),
    },
  ];

  const detectsComposeFile = (input: ConfigTranslateDetectInput): boolean =>
    input.documents.some((document) => document.sourceId === COMPOSE_FILE);

  const composeTranslator: ConfigTranslatorShape = {
    id: "compose",
    summary: "Translate a docker-compose project into a Landofile fragment.",
    inputKinds: ["docker-compose"],
    detect: (input) =>
      Effect.succeed(
        detectsComposeFile(input)
          ? [{ translator: "compose", sourceIds: [COMPOSE_FILE], confidence: "likely" as const }]
          : [],
      ),
    translate: () =>
      Effect.succeed({
        outputs: [
          {
            targetLayer: "canonical",
            fragment: { name: "myapp", recipe: "lamp" },
            sourceIds: [COMPOSE_FILE],
          },
        ],
        diagnostics: [
          {
            kind: "generated" as const,
            message: "Derived recipe from compose services.",
            sourceId: COMPOSE_FILE,
            keyPath: [],
          },
        ],
        deletions: [],
      }),
  };

  test("the compose fixture satisfies the config-translator contract suite", async () => {
    const exit = await Effect.runPromiseExit(
      runConfigTranslatorContractSuite({
        translator: composeTranslator,
        translateInput: {
          _tag: "landofile-document-set",
          documents,
          mode: "full",
          selectedSourceIds: [COMPOSE_FILE],
          currentLowerV4Fragments: [],
          writableLayerIds: ["canonical"],
        },
        detectInput: { documents },
        nonMatchingDetectInput: { documents: [] },
      }),
    );
    expect(Exit.isSuccess(exit)).toBe(true);
  });

  // The command resolves a target encoder even for detect; listing includes that target.
  test("the translate command drives the contract-valid fixture through list/detect/from/file", async () => {
    const cwd = await makeAppDir("name: demo\nruntime: 4\n");
    await Bun.write(join(cwd, "docker-compose.yml"), "services: {}\n");
    const translators = withEncoder([composeTranslator]);

    const listed = await Effect.runPromise(appConfigTranslate({ list: true, translators }));
    expect(listed.mode).toBe("list");
    if (listed.mode === "list") expect(listed.translators.map((t) => t.id)).toEqual(["compose", "lando4"]);

    const detectedMatches = await Effect.runPromise(
      appConfigTranslate({ cwd, detect: true, files: ["docker-compose.yml"], translators }),
    );
    expect(detectedMatches.mode).toBe("detect");
    if (detectedMatches.mode === "detect") {
      expect<unknown>(detectedMatches.matches).toEqual([
        { translator: "compose", sourceIds: ["docker-compose.yml"], confidence: "likely" },
      ]);
    }

    const autodetected = await Effect.runPromise(appConfigTranslate({ cwd, translators }));
    expect(autodetected.mode).toBe("preview");
    if (autodetected.mode === "preview") {
      expect(autodetected.translator).toBe("compose");
      expect(autodetected.files).toContain("docker-compose.yml");
    }

    const detected = await Effect.runPromise(
      appConfigTranslate({ cwd, files: ["docker-compose.yml"], translators }),
    );
    expect(detected.mode).toBe("preview");
    if (detected.mode === "preview") {
      expect(detected.translator).toBe("compose");
      expect(detected.files).toContain("docker-compose.yml");
      expect(detected.content).toContain("recipe: lamp");
    }

    const forced = await Effect.runPromise(appConfigTranslate({ cwd, from: "compose", translators }));
    expect(forced.mode).toBe("preview");
    if (forced.mode === "preview") expect(forced.translator).toBe("compose");
  });

  test("--file rejects application sources that discovery excludes", async () => {
    const cwd = await makeAppDir("name: demo\nruntime: 4\n");
    await Bun.write(join(cwd, "application.ts"), "export default 1;\n");
    let calls = 0;
    const base = makeTranslator("v3", { name: "demo" });
    const translator: ConfigTranslatorShape = {
      ...base,
      translate: (input) => {
        calls++;
        return base.translate(input);
      },
    };
    const exit = await runExit(
      appConfigTranslate({ cwd, files: ["application.ts"], translators: withEncoder([translator]) }),
    );
    expect(failureTag(exit)).toBe("ConfigTranslateError");
    expect(failureValue(exit)?.message).toContain("application.ts");
    expect(calls).toBe(0);
  });

  test("--write fails closed when a target layer already has a TypeScript Landofile", async () => {
    const cwd = await makeAppDir("name: unused\n");
    await rm(join(cwd, ".lando.yml"));
    await Bun.write(join(cwd, ".lando.ts"), "export default {};\n");
    await Bun.write(join(cwd, "docker-compose.yml"), "services: {}\n");
    const exit = await runExit(
      appConfigTranslate({
        cwd,
        write: true,
        translators: withEncoder([makeTranslator("v3", { name: "demo", runtime: 4 })]),
      }),
    );
    expect(failureTag(exit)).toBe("ConfigTranslateError");
    expect(existsSync(join(cwd, ".lando.yml"))).toBe(false);
    expect(await Bun.file(join(cwd, ".lando.ts")).text()).toBe("export default {};\n");
  });
});
