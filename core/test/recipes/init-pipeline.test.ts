import { afterEach, expect, test } from "bun:test";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeConfigTranslatorRegistryLive } from "@lando/engine/plugins/config-translator-registry";
import { plugin } from "@lando/lando4";
import { createStandaloneRedactor } from "@lando/redaction/service";
import { type ConfigTranslateDiagnostic, ConfigTranslateSourceId } from "@lando/sdk/schema";
import { ConfigTranslatorRegistry, ProcessRunner } from "@lando/sdk/services";
import { Effect, Either, Schema, Stream } from "effect";
import {
  RecipeInitBlockedError,
  RecipeInitCommitError,
  type RecipeInitPipelineRequest,
  RecipeInitPostInitError,
  previewRecipeLandofile,
  runRecipeInitPipeline,
} from "../../src/recipes/init-pipeline.ts";
import { secretReference } from "../../src/recipes/init-pipeline/secrets.ts";
import { makeRecipeTranslatorModule } from "../../src/recipes/translator-module.ts";
import { isolatedInitDecomposer, isolatedInitManifest } from "./fixtures/isolated-init-recipe/index.ts";

const roots: string[] = [];
const diagnostic = (kind: ConfigTranslateDiagnostic["kind"], message: string): ConfigTranslateDiagnostic => ({
  kind,
  message,
  remediation: message,
  sourceId: ConfigTranslateSourceId.make("recipe:isolated-init@1.0.0"),
  keyPath: [],
});
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
const temporary = async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "recipe-init-pipeline-")));
  roots.push(root);
  return root;
};
const fixture = async () => {
  const appRoot = await temporary();
  const journalRoot = await temporary();
  const sourceRoot = await temporary();
  const source = join(sourceRoot, "isolated.conf");
  await Bun.write(source, "isolated = true\n");
  const loader = plugin.configTranslators?.get("lando4");
  if (loader === undefined) throw new Error("Missing lando4 lazy loader");
  const calls: string[] = [];
  const landofile = join(appRoot, ".lando.yml");
  const auxiliary = join(appRoot, "config/isolated.conf");
  const request: RecipeInitPipelineRequest = {
    appRoot,
    sourceRoot,
    journalRoot: () => journalRoot,
    manifest: {
      ...isolatedInitManifest,
      files: [{ src: source, dest: "config/isolated.conf", template: false }],
      postInit: [
        {
          type: "command",
          cmd: "app:config:translate",
          secretEnv: { ISOLATED_API_TOKEN: "apiToken" },
        },
      ],
    },
    decomposer: isolatedInitDecomposer,
    answers: { php: "8.3", webroot: "web" },
    appName: "isolated-init",
    encoder: await loader(),
    checkpoint: (point) =>
      Effect.sync(() => {
        if (point === "committed") calls.push("commit");
      }),
    runPostInit: async () => {
      expect(await Bun.file(landofile).exists()).toBe(true);
      expect(await Bun.file(auxiliary).exists()).toBe(true);
      calls.push("postInit");
      return { executed: [{ index: 0, type: "command" }] };
    },
  };
  return { request, calls, landofile, auxiliary };
};
const failure = async (request: RecipeInitPipelineRequest) => {
  const result = await Effect.runPromise(Effect.either(runRecipeInitPipeline(request)));
  if (Either.isRight(result)) throw new Error("Expected pipeline failure");
  return result.left;
};

test("S1 commits expression-bearing provenance before auxiliary files and postInit", async () => {
  const { request, calls, landofile, auxiliary } = await fixture();
  const result = await Effect.runPromise(runRecipeInitPipeline(request));
  expect(calls).toEqual(["commit", "postInit"]);
  const text = await Bun.file(landofile).text();
  expect(text).toContain("{{ recipe.php }}");
  expect(text).toMatch(/recipe:\n\s+id: isolated-init/);
  expect(text).toMatch(/\n\s+producer:\n/);
  expect(await Bun.file(auxiliary).text()).toBe("isolated = true\n");
  expect(result.landofilePath).toBe(landofile);
  expect(result.auxiliaryFiles).toEqual([auxiliary]);
});
test("preview encodes the committed Landofile without writing anything", async () => {
  const { request, calls, landofile, auxiliary } = await fixture();
  const preview = await Effect.runPromise(previewRecipeLandofile(request));
  expect(preview.text).toContain("{{ recipe.php }}");
  expect(preview.text).toMatch(/^name: isolated-init$/m);
  expect(calls).toEqual([]);
  expect(await Bun.file(landofile).exists()).toBe(false);
  expect(await Bun.file(auxiliary).exists()).toBe(false);
  await Effect.runPromise(runRecipeInitPipeline(request));
  expect(await Bun.file(landofile).text()).toBe(preview.text);
});
test("blocks unauthorized post-init actions before writing any scaffold", async () => {
  // Given a direct pipeline caller that bypasses manifest-service validation
  const { request, calls, landofile, auxiliary } = await fixture();
  const unauthorized: RecipeInitPipelineRequest = {
    ...request,
    manifest: {
      ...request.manifest,
      postInit: [...(request.manifest.postInit ?? []), { type: "command", cmd: "app:destroy" }],
    },
  };

  // When the pipeline receives a command outside the post-init allowlist
  const error = await failure(unauthorized);

  // Then authorization fails closed before the transaction or auxiliary writes
  expect(error).toMatchObject({ _tag: "RecipeInitBlockedError", stage: "validate" });
  expect(calls).toEqual([]);
  expect(await Bun.file(landofile).exists()).toBe(false);
  expect(await Bun.file(auxiliary).exists()).toBe(false);
});
test("blocks app:start without a declared opt-in prompt before writing any scaffold", async () => {
  // Given a direct pipeline caller with an app:start guard that names no declared prompt
  const { request, calls, landofile, auxiliary } = await fixture();
  const unauthorized: RecipeInitPipelineRequest = {
    ...request,
    manifest: {
      ...request.manifest,
      postInit: [
        ...(request.manifest.postInit ?? []),
        { type: "command", cmd: "app:start", when: "options.start" },
      ],
    },
  };

  // When the pipeline authorizes post-init before committing
  const error = await failure(unauthorized);

  // Then the missing opt-in declaration fails closed before every write
  expect(error).toMatchObject({ _tag: "RecipeInitBlockedError", stage: "validate" });
  expect(calls).toEqual([]);
  expect(await Bun.file(landofile).exists()).toBe(false);
  expect(await Bun.file(auxiliary).exists()).toBe(false);
});
test("preview fails closed on the same blocking diagnostics as the write path", async () => {
  const { request, landofile } = await fixture();
  const encode = request.encoder.encode;
  if (encode === undefined) throw new Error("Missing encoder");
  const result = await Effect.runPromise(
    Effect.either(
      previewRecipeLandofile({
        ...request,
        encoder: {
          ...request.encoder,
          encode: (input) =>
            Effect.map(encode(input), (encoded) => ({
              ...encoded,
              diagnostics: [...encoded.diagnostics, diagnostic("unsupported", "blocked preview")],
            })),
        },
      }),
    ),
  );
  if (Either.isRight(result)) throw new Error("Expected preview failure");
  expect(result.left).toBeInstanceOf(RecipeInitBlockedError);
  expect(result.left).toMatchObject({ stage: "diagnostics" });
  expect(await Bun.file(landofile).exists()).toBe(false);
});
test("user appName wins over the translated fragment name", async () => {
  const { request, landofile } = await fixture();
  await Effect.runPromise(runRecipeInitPipeline({ ...request, appName: "user-chosen-name" }));
  expect(await Bun.file(landofile).text()).toMatch(/^name: user-chosen-name$/m);
});
test("S2 invalid secret disposition blocks all writes and postInit", async () => {
  const { request, calls, landofile, auxiliary } = await fixture();
  const error = await failure({ ...request, manifest: { ...request.manifest, postInit: [] } });
  expect(error).toBeInstanceOf(RecipeInitBlockedError);
  expect(error).toMatchObject({ stage: "secret-prompts" });
  expect(await Bun.file(landofile).exists()).toBe(false);
  expect(await Bun.file(auxiliary).exists()).toBe(false);
  expect(calls).toEqual([]);
});
test.each(["unsupported", "non-portable"] as const)("S2 %s diagnostic blocks all writes", async (kind) => {
  const { request, calls, landofile, auxiliary } = await fixture();
  const error = await failure({
    ...request,
    encoder: {
      ...request.encoder,
      encode: () =>
        Effect.succeed({
          text: "name: blocked\n",
          diagnostics: [diagnostic(kind, "blocked")],
        }),
    },
  });
  expect(error).toMatchObject({ _tag: "RecipeInitBlockedError", stage: "diagnostics" });
  expect(await Bun.file(landofile).exists()).toBe(false);
  expect(await Bun.file(auxiliary).exists()).toBe(false);
  expect(calls).toEqual([]);
});
test("S3 commit checkpoint failure prevents auxiliary files and postInit", async () => {
  const { request, calls, landofile, auxiliary } = await fixture();
  const error = await failure({
    ...request,
    checkpoint: (point) => (point === "committing" ? Effect.fail("injected") : Effect.void),
  });
  expect(error).toBeInstanceOf(RecipeInitCommitError);
  expect(error).toMatchObject({ phase: "commit", reason: "checkpoint" });
  expect(error.message).toContain("interrupted-checkpoint");
  expect(await Bun.file(landofile).exists()).toBe(false);
  expect(await Bun.file(auxiliary).exists()).toBe(false);
  expect(calls).toEqual([]);
});
test("S4 postInit rejection reports and keeps the committed scaffold", async () => {
  const { request, landofile, auxiliary } = await fixture();
  const error = await failure({
    ...request,
    runPostInit: async () => {
      throw new Error("SECRET_MARKER_9f3a");
    },
  });
  expect(error).toBeInstanceOf(RecipeInitPostInitError);
  expect(error).toMatchObject({
    committedLandofile: landofile,
    committedAuxiliaryFiles: [auxiliary],
    failedAction: "postInit[0] (command)",
    rolledBack: false,
  });
  expect(await Bun.file(landofile).exists()).toBe(true);
  expect(await Bun.file(auxiliary).exists()).toBe(true);
  expect(error.message).toContain("kept");
  expect(error.remediation).toContain("NOT rolled back");
  expect(JSON.stringify(error)).not.toContain("SECRET_MARKER_9f3a");
});
test("S5 raw secrets reach only the declared env sink and not persisted or returned data", async () => {
  const { request } = await fixture();
  const marker = "SECRET_MARKER_9f3a";
  let received: string | undefined;
  const encode = request.encoder.encode;
  if (encode === undefined) throw new Error("Missing encoder");
  const result = await Effect.runPromise(
    runRecipeInitPipeline({
      ...request,
      secretAnswers: { apiToken: marker },
      encoder: {
        ...request.encoder,
        encode: (input) =>
          encode(input).pipe(
            Effect.map((encoded) => ({
              ...encoded,
              diagnostics: [diagnostic("needs-review", marker)],
            })),
          ),
      },
      runPostInit: async (options) => {
        received = options.env?.ISOLATED_API_TOKEN;
        expect(JSON.stringify(options.answers)).not.toContain(marker);
        return { executed: [] };
      },
    }),
  );
  expect(received).toBe(marker);
  for (const path of [result.landofilePath, ...result.auxiliaryFiles])
    expect(await Bun.file(path).text()).not.toContain(marker);
  for (const diagnostic of result.diagnostics) {
    expect(diagnostic.message).not.toContain(marker);
    expect(diagnostic.remediation ?? "").not.toContain(marker);
  }
  expect(JSON.stringify(result)).not.toContain(marker);
});
test("overlapping secrets redact longest-first so suffixes do not leak", async () => {
  const { request } = await fixture();
  const encode = request.encoder.encode;
  if (encode === undefined) throw new Error("Missing encoder");
  const result = await Effect.runPromise(
    runRecipeInitPipeline({
      ...request,
      secretAnswers: { apiToken: "abcdef", other: "abc" },
      encoder: {
        ...request.encoder,
        encode: (input) =>
          encode(input).pipe(
            Effect.map((encoded) => ({
              ...encoded,
              diagnostics: [diagnostic("needs-review", "token=abcdef")],
            })),
          ),
      },
      runPostInit: async () => ({ executed: [] }),
    }),
  );
  for (const item of result.diagnostics) {
    expect(item.message).not.toContain("abc");
    expect(item.remediation ?? "").not.toContain("abc");
  }
  expect(JSON.stringify(result)).not.toContain("abcdef");
});
test("S6 the in-process recipe module lists through ConfigTranslatorRegistry", async () => {
  const module = makeRecipeTranslatorModule({
    decomposers: new Map([[isolatedInitManifest.id, isolatedInitDecomposer]]),
    redactor: createStandaloneRedactor("secrets"),
  });
  const translators = await Effect.runPromise(
    Effect.flatMap(ConfigTranslatorRegistry, (registry) => registry.list).pipe(
      Effect.provide(makeConfigTranslatorRegistryLive([module])),
    ),
  );
  expect(translators.map(({ id }) => id)).toEqual(["recipe"]);
});
test("existing auxiliary files are preserved and an existing Landofile blocks init", async () => {
  const { request, calls, landofile, auxiliary } = await fixture();
  await Bun.write(auxiliary, "keep me");
  await Bun.write(landofile, "name: before\n");
  const error = await failure(request);
  expect(error).toMatchObject({ _tag: "RecipeInitCommitError", phase: "prepare", reason: "conflict" });
  expect(calls).toEqual([]);
  expect(await Bun.file(auxiliary).text()).toBe("keep me");
  expect(await Bun.file(landofile).text()).toBe("name: before\n");
});

test.each(["when", "mode", "engine"] as const)(
  "blocks unsupported auxiliary file field %s before writing the Landofile",
  async (field) => {
    const { request, calls, landofile, auxiliary } = await fixture();
    const file = { src: "ignored", dest: "config/isolated.conf", [field]: "unsupported" };
    const error = await failure({ ...request, manifest: { ...request.manifest, files: [file] } });
    expect(error).toMatchObject({ _tag: "RecipeInitBlockedError", stage: "validate" });
    expect(calls).toEqual([]);
    expect(await Bun.file(landofile).exists()).toBe(false);
    expect(await Bun.file(auxiliary).exists()).toBe(false);
  },
);
test("stdin is bound through the action runner, never answers, env, or argv", async () => {
  const { request } = await fixture();
  const marker = "SECRET_MARKER_9f3a";
  const inputs: unknown[] = [];
  const program = runRecipeInitPipeline({
    ...request,
    secretAnswers: { apiToken: marker },
    manifest: {
      ...request.manifest,
      prompts: [
        {
          name: "apiToken",
          type: "secret",
          message: "token",
          disposition: { kind: "init-only", sink: { kind: "stdin" } },
        },
      ],
      postInit: [{ type: "command", cmd: "app:config:translate", stdin: { prompt: "apiToken" } }],
    },
    runPostInit: async (options) => {
      expect(JSON.stringify([options.env, options.answers, options.actions])).not.toContain(marker);
      if (options.commandRunner === undefined) throw new Error("Missing bound runner");
      await options.commandRunner({ command: "app:config:translate", args: [] });
      return { executed: [] };
    },
  }).pipe(
    Effect.provideService(ProcessRunner, {
      run: (input) =>
        Effect.sync(() => {
          inputs.push(input);
          return { exitCode: 0, stdout: "", stderr: "" };
        }),
      stream: () => Stream.empty,
    }),
  );
  await Effect.runPromise(program);
  expect(inputs).toHaveLength(1);
  expect(inputs[0]).toMatchObject({ stdin: marker });
});

test("fails closed on a relative auxiliary source instead of resolving it against the working directory", async () => {
  const { request, calls, landofile, auxiliary } = await fixture();
  const error = await failure({
    ...request,
    manifest: {
      ...request.manifest,
      files: [{ src: "templates/isolated.conf", dest: "config/isolated.conf", template: false }],
    },
  });
  expect(error).toBeInstanceOf(RecipeInitBlockedError);
  expect(error).toMatchObject({ stage: "validate" });
  expect(await Bun.file(landofile).exists()).toBe(false);
  expect(await Bun.file(auxiliary).exists()).toBe(false);
  expect(calls).toEqual([]);
});

test("S7 writes a bundled in-memory auxiliary asset with no on-disk source", async () => {
  const { request, landofile } = await fixture();
  const appRoot = request.appRoot;
  const result = await Effect.runPromise(
    runRecipeInitPipeline({
      ...request,
      manifest: {
        ...request.manifest,
        files: [
          { src: "templates/.lando.yml.tmpl", dest: ".lando.yml", template: true },
          { src: "templates/package.json.tmpl", dest: "package.json", template: true },
          { src: "assets/notes.txt", dest: "notes.txt", template: false },
        ],
      },
      runPostInit: async () => ({ executed: [] }),
      contentSource: (file) =>
        Promise.resolve(
          file.dest === "package.json"
            ? '{ "name": "{{ app.name }}" }\n'
            : file.dest === "notes.txt"
              ? "verbatim {{ app.name }}\n"
              : undefined,
        ),
    }),
  );
  // The manifest Landofile entry belongs to the transaction, never the aux loop.
  expect(result.auxiliaryFiles).toEqual([join(appRoot, "package.json"), join(appRoot, "notes.txt")]);
  expect(await Bun.file(join(appRoot, "package.json")).text()).toBe('{ "name": "isolated-init" }\n');
  expect(await Bun.file(join(appRoot, "notes.txt")).text()).toBe("verbatim {{ app.name }}\n");
  expect(await Bun.file(landofile).exists()).toBe(true);
});

test("S7 blocks when the content source declines an entry with no absolute source", async () => {
  const { request } = await fixture();
  const error = await failure({
    ...request,
    manifest: {
      ...request.manifest,
      files: [{ src: "templates/missing.tmpl", dest: "missing.txt", template: false }],
    },
    contentSource: () => Promise.resolve(undefined),
  });
  expect(error).toBeInstanceOf(RecipeInitBlockedError);
  expect((error as RecipeInitBlockedError).stage).toBe("validate");
});

test("stored-secret references preserve the supplied canonical reference", () => {
  expect(
    secretReference({ kind: "secret-store", field: "database.password" }, "${secret:team/database}"),
  ).toEqual({ disposition: "secret-store", reference: "${secret:team/database}" });
});

test("stored-secret prompt names receive references that the decomposer may persist", async () => {
  const { request, landofile } = await fixture();
  let received: unknown;
  const result = await Effect.runPromise(
    runRecipeInitPipeline({
      ...request,
      manifest: {
        ...request.manifest,
        prompts: [
          ...(request.manifest.prompts ?? []).filter((prompt) => prompt.name !== "apiToken"),
          {
            name: "apiToken",
            type: "secret",
            message: "API token",
            disposition: { kind: "secret-store", field: "database.password" },
          },
        ],
        postInit: [],
      },
      secretAnswers: { apiToken: "${secret:team/database}" },
      decomposer: (ports) => {
        const base = request.decomposer(ports);
        return {
          ...base,
          decompose: (input) => {
            received = input.secrets;
            const stored = input.secrets.apiToken;
            return Effect.map(base.decompose(input), (output) => {
              const fragment = Schema.decodeUnknownEither(
                Schema.Record({ key: Schema.String, value: Schema.Unknown }),
              )(output.fragment);
              return {
                ...output,
                fragment:
                  Either.isRight(fragment) && stored?.disposition === "secret-store"
                    ? { ...fragment.right, "x-secret-reference": stored.reference }
                    : output.fragment,
              };
            });
          },
        };
      },
      runPostInit: async () => ({ executed: [] }),
    }),
  );
  expect(received).toEqual({
    apiToken: { disposition: "secret-store", reference: "${secret:team/database}" },
  });
  expect(await Bun.file(landofile).text()).toContain("${secret:team/database}");
  expect(JSON.stringify(result)).not.toContain("${secret:team/database}");
});

test("a missing stored-secret reference fails with the tagged secret boundary", async () => {
  const { request, landofile } = await fixture();
  const error = await failure({
    ...request,
    manifest: {
      ...request.manifest,
      prompts: [
        ...(request.manifest.prompts ?? []).filter((prompt) => prompt.name !== "apiToken"),
        {
          name: "apiToken",
          type: "secret",
          message: "API token",
          disposition: { kind: "secret-store", field: "database.password" },
        },
      ],
      postInit: [],
    },
  });
  expect(error).toMatchObject({ _tag: "RecipeInitBlockedError", stage: "secret-prompts" });
  expect(await Bun.file(landofile).exists()).toBe(false);
});
