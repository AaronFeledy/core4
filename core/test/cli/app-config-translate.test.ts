import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Cause, Effect, Exit, Schema } from "effect";

import {
  type ConfigTranslateInput,
  ConfigTranslateSourceId,
  type LandofileAuthoringFragmentWire,
} from "@lando/sdk/schema";
import type { ConfigTranslateDetectInput, ConfigTranslatorShape } from "@lando/sdk/services";
import { runConfigTranslatorContractSuite } from "@lando/sdk/test";

import { parseLandofile } from "@lando/landofile/parser";
import {
  type AppConfigTranslateResult,
  AppConfigTranslateResultSchema,
  appConfigTranslate,
  renderConfigTranslateResult,
} from "../../src/cli/commands/app-config-translate.ts";

const dirs: Array<string> = [];

afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

const makeAppDir = async (landofile: string): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), "lando-translate-"));
  dirs.push(dir);
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
  detect: () =>
    Effect.succeed(
      options.detects === false
        ? []
        : [{ translator: id, sourceIds: [], confidence: options.confidence ?? ("likely" as const) }],
    ),
  translate: (input) =>
    Effect.succeed({
      outputs: [{ targetLayer: "canonical", fragment, sourceIds: [] }],
      diagnostics: [
        {
          kind: "generated" as const,
          message: `${id} added keys`,
          sourceId:
            input._tag === "recipe-request"
              ? input.sourceId
              : (input.documents[0]?.sourceId ?? ConfigTranslateSourceId.make("missing")),
          keyPath: [],
        },
      ],
      deletions: [],
    }),
});

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
          content: "name: demo\n",
          diagnostics,
          deletions,
        },
        { mode: "write", inputPath: ".lando.yml", outputPath: ".lando.yml", diagnostics, deletions },
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
  test("passes bounded byte snapshots and full document-set ownership when previewing", async () => {
    const cwd = await makeAppDir("name: demo\n");
    const bytes = new TextEncoder().encode("services: {}\n");
    await Bun.write(join(cwd, "docker-compose.yml"), bytes);
    const inputs: ConfigTranslateInput[] = [];
    const base = makeTranslator("compose", {});
    await Effect.runPromise(
      appConfigTranslate({
        cwd,
        files: ["docker-compose.yml"],
        translators: [
          {
            ...base,
            translate: (input) => {
              inputs.push(input);
              return base.translate(input);
            },
          },
        ],
      }),
    );
    expect<unknown>(inputs).toEqual([
      {
        _tag: "landofile-document-set",
        documents: [
          {
            sourceId: "docker-compose.yml",
            path: "docker-compose.yml",
            layerId: "canonical",
            mediaType: "application/yaml",
            contentDigest: `sha256:${new Bun.CryptoHasher("sha256").update(bytes).digest("hex")}`,
            bytes,
          },
        ],
        mode: "full",
        selectedSourceIds: ["docker-compose.yml"],
        currentLowerV4Fragments: [],
        writableLayerIds: ["canonical"],
      },
    ]);
  });

  test("preserves unresolved typed expressions when merging authoring fragments", async () => {
    const cwd = await makeAppDir('name: demo\nrouter:\n  enabled: "{{ env.ENABLED }}"\n');
    const result = await Effect.runPromise(
      appConfigTranslate({
        cwd,
        translators: [makeTranslator("v3", { services: { web: { port: "{{ env.PORT }}" } } })],
      }),
    );
    expect(result.mode).toBe("preview");
    if (result.mode === "preview") expect(result.content).toContain('port: "{{ env.PORT }}"');
  });

  test("rejects output to an unwritable layer", async () => {
    const cwd = await makeAppDir("name: demo\n");
    const translator = {
      ...makeTranslator("v3", {}),
      translate: () =>
        Effect.succeed({
          outputs: [{ targetLayer: "local" as const, fragment: {}, sourceIds: [] }],
          diagnostics: [],
          deletions: [],
        }),
    };
    expect(failureTag(await runExit(appConfigTranslate({ cwd, translators: [translator] })))).toBe(
      "ConfigTranslateError",
    );
  });

  test("fails closed without writing when deletion intents are returned", async () => {
    const original = "name: demo\n";
    const cwd = await makeAppDir(original);
    const translator = {
      ...makeTranslator("v3", {}),
      translate: () =>
        Effect.succeed({
          outputs: [],
          diagnostics: [],
          deletions: [{ sourceId: ConfigTranslateSourceId.make(".lando.yml") }],
        }),
    };
    const exit = await runExit(appConfigTranslate({ cwd, write: true, translators: [translator] }));
    expect(failureTag(exit)).toBe("ConfigTranslateError");
    expect(failureValue(exit)?.remediation).toContain("managed-file transaction");
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
        translators: [makeTranslator("v3", {})],
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
  test("previews the canonical Landofile without writing by default", async () => {
    const cwd = await makeAppDir("name: demo\nruntime: 4\n");
    const translators = [makeTranslator("v3", { services: { db: { type: "mysql:8.0" } } })];
    const result = await Effect.runPromise(appConfigTranslate({ cwd, translators }));
    expect(result.mode).toBe("preview");
    if (result.mode !== "preview") throw new Error("expected preview mode");
    expect(result.translator).toBe("v3");
    expect(result.content).toContain("name: demo");
    expect(result.content).toContain("db");
    expect(result.diagnostics.length).toBe(1);

    // Preview must NOT write a `.canonical` file next to the input.
    expect(existsSync(join(cwd, ".lando.yml.canonical"))).toBe(false);

    // The previewed content round-trips through the canonical parser.
    const parsed = (await Effect.runPromise(
      parseLandofile({ file: join(cwd, ".lando.yml"), content: result.content, cwd }),
    )) as Record<string, unknown>;
    expect(parsed).toEqual({
      name: "demo",
      runtime: 4,
      services: { db: { type: "mysql:8.0" } },
    });

    // The input file is left untouched.
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
    expect(result.matches).toEqual([{ translator: "v3", sourceIds: [], confidence: "likely" }]);
    expect(translated).toBe(false);
    expect(renderConfigTranslateResult(result, "table")).toContain("v3\tlikely");
  });

  test("autodetection discovers in-root symlinked source files", async () => {
    const cwd = await makeAppDir("name: demo\nruntime: 4\n");
    await mkdir(join(cwd, "compose"), { recursive: true });
    await Bun.write(join(cwd, "compose", "docker-compose.yml"), "services: {}\n");
    await symlink(join(cwd, "compose", "docker-compose.yml"), join(cwd, "docker-compose.yml"));

    const translators = [makeTranslator("compose", {})];
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

    const translators = [makeTranslator("compose", {})];
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

    const translators = [makeTranslator("compose", {})];
    const result = await Effect.runPromise(appConfigTranslate({ cwd, detect: true, translators }));

    expect(result.mode).toBe("detect");
    if (result.mode !== "detect") throw new Error("expected detect mode");
    expect(result.files).toEqual([".lando.yml", "docker-compose.yml"]);
  });

  test("--from forces a specific translator", async () => {
    const cwd = await makeAppDir("name: demo\nruntime: 4\n");
    const translators = [
      makeTranslator("v3", { services: { db: { type: "mysql:8.0" } } }),
      makeTranslator("compose", { services: { cache: { type: "redis:7" } } }),
    ];
    const result = await Effect.runPromise(appConfigTranslate({ cwd, from: "v3", translators }));
    expect(result.mode).toBe("preview");
    if (result.mode !== "preview") throw new Error("expected preview mode");
    expect(result.translator).toBe("v3");
    expect(result.content).toContain("db");
    expect(result.content).not.toContain("cache");
  });

  test("--from with an unknown id fails with remediation listing available translators", async () => {
    const cwd = await makeAppDir("name: demo\nruntime: 4\n");
    const translators = [makeTranslator("v3", {}), makeTranslator("compose", {})];
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
    const translators = [makeTranslator("v3", { services: { db: { type: "mysql:8.0" } } })];
    const result = await Effect.runPromise(
      appConfigTranslate({ cwd, files: ["docker-compose.yml"], translators }),
    );
    expect(result.mode).toBe("preview");
    if (result.mode !== "preview") throw new Error("expected preview mode");
    expect(result.files).toContain("docker-compose.yml");
  });

  test("--file rejects paths outside the app root", async () => {
    const cwd = await makeAppDir("name: demo\nruntime: 4\n");
    const translators = [makeTranslator("v3", {})];

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
    const translators = [
      makeTranslator("v3", { services: { db: { type: "mysql:8.0" } } }),
      makeTranslator("compose", { services: { cache: { type: "redis:7" } } }),
    ];
    const exit = await runExit(appConfigTranslate({ cwd, translators }));
    expect(Exit.isFailure(exit)).toBe(true);
    expect(failureTag(exit)).toBe("ConfigTranslateError");
    const remediation = failureValue(exit)?.remediation ?? "";
    expect(remediation).toContain("v3");
    expect(remediation).toContain("compose");
  });

  test("autodetection with no matching translator fails with remediation", async () => {
    const cwd = await makeAppDir("name: demo\nruntime: 4\n");
    const translators = [makeTranslator("v3", {}, { detects: false })];
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

  test("--write overwrites the input and keeps a .bak backup of the original", async () => {
    const original = "name: demo\nruntime: 4\n";
    const cwd = await makeAppDir(original);
    const translators = [makeTranslator("v3", { services: { cache: { type: "redis:7" } } })];
    const result = await Effect.runPromise(appConfigTranslate({ cwd, write: true, translators }));
    expect(result.mode).toBe("write");
    if (result.mode !== "write") throw new Error("expected write mode");
    expect(result.outputPath).toBe(join(cwd, ".lando.yml"));
    expect(result.backupPath).toBe(join(cwd, ".lando.yml.bak"));

    const backup = await readFile(join(cwd, ".lando.yml.bak"), "utf8");
    expect(backup).toBe(original);

    const written = await readFile(join(cwd, ".lando.yml"), "utf8");
    const parsed = (await Effect.runPromise(
      parseLandofile({ file: result.outputPath, content: written, cwd }),
    )) as Record<string, unknown>;
    expect(parsed).toEqual({
      name: "demo",
      runtime: 4,
      services: { cache: { type: "redis:7" } },
    });
  });

  test("rejects unsupported tooling flag metadata before translation", async () => {
    const cwd = await makeAppDir(
      [
        "name: demo",
        "runtime: 4",
        "tooling:",
        "  echo:",
        "    cmd: echo hi",
        "    flags:",
        "      verbose:",
        "        type: boolean",
        "",
      ].join("\n"),
    );
    const translators = [makeTranslator("v3", { services: { db: { type: "mysql:8.0" } } })];

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

  test("renderConfigTranslateResult prints the Landofile and the schema encodes each mode", async () => {
    const cwd = await makeAppDir("name: demo\nruntime: 4\n");
    const translators = [makeTranslator("v3", { services: { db: { type: "mysql:8.0" } } })];
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

  test("the translate command drives the contract-valid fixture through list/detect/from/file", async () => {
    const cwd = await makeAppDir("name: demo\nruntime: 4\n");
    await Bun.write(join(cwd, "docker-compose.yml"), "services: {}\n");
    const translators = [composeTranslator];

    const listed = await Effect.runPromise(appConfigTranslate({ list: true, translators }));
    expect(listed.mode).toBe("list");
    if (listed.mode === "list") expect(listed.translators.map((t) => t.id)).toEqual(["compose"]);

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
});
