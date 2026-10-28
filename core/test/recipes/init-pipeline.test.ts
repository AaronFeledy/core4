import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigTranslateSourceId, LANDOFILE_EDITOR_SCHEMA_URL } from "@lando/sdk/schema";
import { ProcessRunner } from "@lando/sdk/services";
import { Effect, Result, Stream } from "effect";
import { runRecipeInitPipeline } from "../../src/recipes/init-pipeline.ts";
import { secretReference } from "../../src/recipes/init-pipeline/secrets.ts";
import { type RecipeInitPreparationRequest, prepareRecipeInit } from "../../src/recipes/prepared-init.ts";
import { pipelineSourceFixture } from "./fixtures/pipeline-source.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
const fixture = async (patch: Record<string, unknown> = {}) => {
  const root = await mkdtemp(join(tmpdir(), "init-pipeline-"));
  roots.push(root);
  return pipelineSourceFixture(root, patch);
};
const ready = async (request: RecipeInitPreparationRequest) => {
  const result = await Effect.runPromise(prepareRecipeInit(request));
  if (result.status !== "ready") throw new Error("Fixture requires answers");
  return result;
};

test("S1 commits expression-bearing provenance and all auxiliary files before post-init", async () => {
  // Given
  const f = await fixture();
  const prepared = await ready(f.request);
  const calls: string[] = [];
  // When
  const result = await Effect.runPromise(
    runRecipeInitPipeline({
      ...f.publication,
      prepared,
      checkpoint: (point) =>
        Effect.sync(() => {
          if (point === "committed") calls.push("commit");
        }),
      runPostInit: async () => {
        calls.push("postInit");
        return { executed: [] };
      },
    }),
  );
  // Then
  expect(calls).toEqual(["commit", "postInit"]);
  const text = await Bun.file(result.landofilePath).text();
  expect(text.startsWith(`# yaml-language-server: $schema=${LANDOFILE_EDITOR_SCHEMA_URL}\n`)).toBe(true);
  expect(text).toContain("{{ recipe.php }}");
  expect(text).toMatch(/recipe:\n\s+id: prepared/);
  expect(text).toMatch(/\n\s+producer:\n/);
  expect(await Bun.file(join(f.request.appRoot, "config/isolated.conf")).text()).toBe("isolated = true\n");
  expect(result.receipt.created).toHaveLength(2);
});

test("preview encodes the committed Landofile without destination writes", async () => {
  // Given
  const f = await fixture();
  // When
  const prepared = await ready(f.request);
  const before = await readdir(f.root);
  const result = await Effect.runPromise(
    runRecipeInitPipeline({ ...f.publication, prepared, runPostInit: async () => ({ executed: [] }) }),
  );
  // Then
  expect(before).toEqual(["asset"]);
  expect(await Bun.file(result.landofilePath).text()).toBe(prepared.preview.landofile);
});

test.each([
  { type: "command", cmd: "app:destroy" },
  { type: "command", cmd: "app:start" },
])("blocks unauthorized post-init before publishing: %j", async (action) => {
  // Given
  const f = await fixture({ postInit: [action] });
  // When
  const result = await Effect.runPromise(Effect.result(prepareRecipeInit(f.request)));
  // Then
  expect(Result.isFailure(result)).toBe(true);
  expect(await readdir(f.root)).toEqual(["asset"]);
});

test("preview fails closed on blocking encoder diagnostics", async () => {
  // Given
  const f = await fixture();
  // When
  const result = await Effect.runPromise(
    Effect.result(
      prepareRecipeInit({
        ...f.request,
        encoder: {
          ...f.request.encoder,
          encode: () =>
            Effect.succeed({
              text: "runtime: 4\n",
              diagnostics: [
                {
                  kind: "unsupported",
                  message: "unsupported",
                  remediation: "Remove unsupported config",
                  sourceId: ConfigTranslateSourceId.make("recipe:prepared@1.0.0"),
                  keyPath: [],
                },
              ],
            }),
        },
      }),
    ),
  );
  // Then
  expect(Result.isFailure(result) && result.failure).toMatchObject({ stage: "diagnostics" });
  expect(await readdir(f.root)).toEqual(["asset"]);
});

test("user appName wins over the authored fragment name", async () => {
  // Given
  const f = await fixture({ config: { runtime: 4, name: "authored-name" } });
  // When
  const prepared = await ready(f.request);
  // Then
  expect(prepared.preview.landofile).toMatch(/^name: chosen-name$/m);
});

test("S2 unsafe secret disposition blocks read-only preparation", async () => {
  // Given
  const f = await fixture({
    options: {
      token: { type: { kind: "secret" }, disposition: { kind: "secret-store", field: "services.app.image" } },
    },
  });
  // When
  const result = await Effect.runPromise(Effect.result(prepareRecipeInit(f.request)));
  // Then
  expect(Result.isFailure(result) && result.failure).toMatchObject({ stage: "secret-prompts" });
  expect(await readdir(f.root)).toEqual(["asset"]);
});

test("S3 commit checkpoint failure prevents static publication and post-init", async () => {
  // Given
  const f = await fixture();
  const prepared = await ready(f.request);
  let ran = false;
  // When
  const result = await Effect.runPromise(
    Effect.result(
      runRecipeInitPipeline({
        ...f.publication,
        prepared,
        checkpoint: (point) => (point === "committing" ? Effect.fail("interrupt") : Effect.void),
        runPostInit: async () => {
          ran = true;
          return { executed: [] };
        },
      }),
    ),
  );
  // Then
  expect(Result.isFailure(result) && result.failure).toMatchObject({
    _tag: "RecipeInitCommitError",
    phase: "commit",
    reason: "checkpoint",
    transactionState: "committing",
  });
  expect(await Bun.file(join(f.request.appRoot, ".lando.yml")).exists()).toBe(false);
  expect(await Bun.file(join(f.request.appRoot, "config/isolated.conf")).exists()).toBe(false);
  expect(ran).toBe(false);
});

test("S4 post-init rejection keeps committed static outputs and scrubs failure details", async () => {
  // Given
  const f = await fixture();
  const prepared = await ready(f.request);
  // When
  const result = await Effect.runPromise(
    Effect.result(
      runRecipeInitPipeline({
        ...f.publication,
        prepared,
        runPostInit: async () => {
          throw new Error("raw-secret-marker");
        },
      }),
    ),
  );
  // Then
  expect(Result.isFailure(result) && result.failure).toMatchObject({
    _tag: "RecipeInitPostInitError",
    rolledBack: false,
    committedLandofile: join(f.request.appRoot, ".lando.yml"),
    committedAuxiliaryFiles: [join(f.request.appRoot, "config/isolated.conf")],
  });
  expect(JSON.stringify(result)).not.toContain("raw-secret-marker");
  expect(await Bun.file(join(f.request.appRoot, "config/isolated.conf")).exists()).toBe(true);
});

test.each(["stdin", "secretEnv"])("S5 raw secrets reach only their one declared %s sink", async (kind) => {
  // Given
  const sink = kind === "stdin" ? { kind: "stdin" } : { kind: "secretEnv", name: "TOKEN" };
  const f = await fixture({
    options: { token: { type: { kind: "secret" }, disposition: { kind: "init-only", sink } } },
    postInit: [
      {
        type: "command",
        cmd: "app:config:translate",
        ...(kind === "stdin" ? { stdin: { prompt: "token" } } : { secretEnv: { TOKEN: "token" } }),
      },
    ],
  });
  const marker = "raw-secret-marker";
  const prepared = await ready({ ...f.request, secretAnswers: { token: marker } });
  const inputs: unknown[] = [];
  // When
  const result = await Effect.runPromise(
    runRecipeInitPipeline({ ...f.publication, prepared }).pipe(
      Effect.provideService(
        ProcessRunner,
        ProcessRunner.of({
          run: (input) =>
            Effect.sync(() => {
              inputs.push(input);
              return { exitCode: 0, stdout: marker, stderr: marker };
            }),
          stream: () => Stream.empty,
          streamWithExit: () => Stream.empty,
        }),
      ),
    ),
  );
  // Then
  expect(inputs).toHaveLength(1);
  expect(inputs[0]).toMatchObject(kind === "stdin" ? { stdin: marker, env: {} } : { env: { TOKEN: marker } });
  expect(JSON.stringify(result)).not.toContain(marker);
  expect(prepared.preview.landofile).not.toContain(marker);
  expect(await Bun.file(join(f.request.appRoot, "config/isolated.conf")).text()).not.toContain(marker);
});

test("overlapping raw secrets redact longest-first in post-init output", async () => {
  // Given
  const options = Object.fromEntries(
    ["short", "long"].map((name) => [
      name,
      {
        type: { kind: "secret" },
        disposition: { kind: "init-only", sink: { kind: "secretEnv", name: name.toUpperCase() } },
      },
    ]),
  );
  const f = await fixture({
    options,
    postInit: [{ type: "command", cmd: "app:config:translate", secretEnv: { SHORT: "short", LONG: "long" } }],
  });
  const prepared = await ready({ ...f.request, secretAnswers: { short: "abc", long: "abcdef" } });
  // When
  const text = prepared.redact("abcdef abc");
  // Then
  expect(text).not.toContain("abc");
  expect(text).not.toContain("def");
});

test("stored-secret references preserve their canonical reference", () => {
  // Given / When
  const value = secretReference(
    { kind: "secret-store", field: "services.app.environment.TOKEN" },
    "${secret:APP_TOKEN}",
  );
  // Then
  expect(value).toEqual({ disposition: "secret-store", reference: "${secret:APP_TOKEN}" });
});

test("missing stored-secret references report requires-input rather than writing", async () => {
  // Given
  const f = await fixture({
    options: {
      token: {
        type: { kind: "secret" },
        disposition: { kind: "secret-store", field: "services.app.environment.TOKEN" },
      },
    },
  });
  // When
  const result = await Effect.runPromise(prepareRecipeInit(f.request));
  // Then
  expect(result).toEqual({ status: "requires-input", missing: ["token"] });
  expect(await readdir(f.root)).toEqual(["asset"]);
});
