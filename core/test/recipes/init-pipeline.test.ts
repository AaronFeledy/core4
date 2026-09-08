import { afterEach, expect, test } from "bun:test";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeConfigTranslatorRegistryLive } from "@lando/engine/plugins/config-translator-registry";
import { plugin } from "@lando/lando4";
import { createStandaloneRedactor } from "@lando/redaction/service";
import { type ConfigTranslateDiagnostic, ConfigTranslateSourceId } from "@lando/sdk/schema";
import { ConfigTranslatorRegistry, ProcessRunner } from "@lando/sdk/services";
import { Effect, Either, Stream } from "effect";
import {
  RecipeInitBlockedError,
  RecipeInitCommitError,
  type RecipeInitPipelineRequest,
  RecipeInitPostInitError,
  runRecipeInitPipeline,
} from "../../src/recipes/init-pipeline.ts";
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
  const source = join(await temporary(), "isolated.conf");
  await Bun.write(source, "isolated = true\n");
  const loader = plugin.configTranslators?.get("lando4");
  if (loader === undefined) throw new Error("Missing lando4 lazy loader");
  const calls: string[] = [];
  const request: RecipeInitPipelineRequest = {
    appRoot,
    journalRoot: () => journalRoot,
    manifest: {
      ...isolatedInitManifest,
      files: [{ src: source, dest: "config/isolated.conf", template: false }],
    },
    decomposer: isolatedInitDecomposer,
    answers: { php: "8.3", webroot: "web" },
    appName: "isolated-init",
    encoder: await loader(),
    checkpoint: (point) =>
      Effect.sync(() => {
        if (point === "committed") calls.push("commit");
      }),
    writeAuxiliaryFile: async (path, content) => {
      calls.push("auxiliary");
      await Bun.write(path, content);
    },
    runPostInit: async () => {
      calls.push("postInit");
      return { executed: [{ index: 0, type: "command" }] };
    },
  };
  const landofile = join(appRoot, ".lando.yml");
  const auxiliary = join(appRoot, "config/isolated.conf");
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
  expect(calls).toEqual(["commit", "auxiliary", "postInit"]);
  const text = await Bun.file(landofile).text();
  expect(text).toContain("{{ recipe.php }}");
  expect(text).toMatch(/recipe:\n\s+id: isolated-init/);
  expect(text).toMatch(/\n\s+producer:\n/);
  expect(await Bun.file(auxiliary).text()).toBe("isolated = true\n");
  expect(result.landofilePath).toBe(landofile);
  expect(result.auxiliaryFiles).toEqual([auxiliary]);
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
test("S6 the real recipe plugin registry lists recipe", async () => {
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
test("existing auxiliary files are skipped and existing landofiles get backups", async () => {
  const { request, calls, landofile, auxiliary } = await fixture();
  await Bun.write(auxiliary, "keep me");
  await Bun.write(landofile, "name: before\n");
  const result = await Effect.runPromise(runRecipeInitPipeline(request));
  expect(calls).toEqual(["commit", "postInit"]);
  expect(await Bun.file(auxiliary).text()).toBe("keep me");
  expect(result.auxiliaryFiles).toEqual([]);
  expect(result.backups).toHaveLength(1);
  expect(await Bun.file(result.backups[0] ?? "").text()).toBe("name: before\n");
});
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
      postInit: [{ type: "command", cmd: "app:info", stdin: { prompt: "apiToken" } }],
    },
    runPostInit: async (options) => {
      expect(JSON.stringify([options.env, options.answers, options.actions])).not.toContain(marker);
      if (options.commandRunner === undefined) throw new Error("Missing bound runner");
      await options.commandRunner({ command: "app:info", args: [] });
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
  const { request, auxiliary } = await fixture();
  const error = await failure({
    ...request,
    manifest: {
      ...request.manifest,
      files: [{ src: "templates/isolated.conf", dest: "config/isolated.conf", template: false }],
    },
  });
  expect(error).toBeInstanceOf(RecipeInitPostInitError);
  expect(await Bun.file(auxiliary).exists()).toBe(false);
});
