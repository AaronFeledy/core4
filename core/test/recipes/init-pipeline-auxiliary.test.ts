import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { plugin } from "@lando/lando4";
import { Effect, Result } from "effect";
import { runRecipeInitPipeline } from "../../src/recipes/init-pipeline.ts";
import { prepareRecipeInit } from "../../src/recipes/prepared-init.ts";
import { ownerOnlyFileAccess } from "../_support/private-file-access.ts";
import { compileTestSource, testSource } from "./fixtures/prepared-source.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
const fixture = async (
  content: Uint8Array,
  options: { readonly template?: boolean; readonly secret?: string; readonly appName?: string } = {},
) => {
  const root = await mkdtemp(join(tmpdir(), "pipeline-aux-"));
  roots.push(root);
  await Bun.write(join(root, "asset"), content);
  const compiled = await compileTestSource(
    {
      ...testSource,
      files: [{ src: "asset", dest: "asset", template: options.template ?? false }],
      ...(options.secret === undefined
        ? {}
        : {
            options: {
              token: {
                type: { kind: "secret" },
                disposition: { kind: "init-only", sink: { kind: "stdin" } },
              },
            },
            postInit: [{ type: "command", cmd: "app:config:translate", stdin: { prompt: "token" } }],
          }),
    },
    root,
  );
  const loader = plugin.configTranslators?.get("lando4");
  if (loader === undefined) throw new Error("Missing encoder");
  const request = {
    compiled,
    appRoot: join(root, "app"),
    appName: options.appName ?? "prepared",
    answers: {},
    ...(options.secret === undefined ? {} : { secretAnswers: { token: options.secret } }),
    encoder: await loader(),
  };
  const publication = { privateFileAccess: ownerOnlyFileAccess, journalRoot: () => join(root, "journal") };
  return { root, request, publication };
};
const ready = async (request: Parameters<typeof prepareRecipeInit>[0]) => {
  const plan = await Effect.runPromise(prepareRecipeInit(request));
  if (plan.status !== "ready") throw new Error("Missing fixture answers");
  return plan;
};

test("preserves the BOM and literal app name when the pipeline renders template bytes", async () => {
  // Given
  const f = await fixture(new TextEncoder().encode("\uFEFF{{ app.name }}\r\n"), {
    template: true,
    appName: "${PORT}-$&",
  });
  const prepared = await ready(f.request);
  // When
  const result = await Effect.runPromise(runRecipeInitPipeline({ ...f.publication, prepared }));
  // Then
  expect(await Bun.file(result.auxiliaryFiles[0] ?? "").bytes()).toEqual(
    new TextEncoder().encode("\uFEFF${PORT}-$&\r\n"),
  );
});

test("stops static publication and post-init when an authorized destination appears during commit", async () => {
  // Given
  const f = await fixture(new TextEncoder().encode("prepared"));
  const prepared = await ready(f.request);
  let ran = false;
  // When
  const result = await Effect.runPromise(
    Effect.result(
      runRecipeInitPipeline({
        ...f.publication,
        prepared,
        checkpoint: (point, index) =>
          point === "before-create-link" && index === 1
            ? Effect.promise(async () => {
                await Bun.write(join(f.request.appRoot, "asset"), "competitor");
              })
            : Effect.void,
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
    reason: "conflict",
    transactionState: "committing",
  });
  expect(await Bun.file(join(f.request.appRoot, "asset")).text()).toBe("competitor");
  expect(ran).toBe(false);
});

test("succeeds when the conflict policy withholds the whole scaffold set", async () => {
  // Given
  const f = await fixture(new TextEncoder().encode("prepared"));
  await mkdir(f.request.appRoot);
  await Bun.write(join(f.request.appRoot, "asset"), "owned");
  const prepared = await ready(f.request);
  // When
  const result = await Effect.runPromise(runRecipeInitPipeline({ ...f.publication, prepared }));
  // Then
  expect(result.auxiliaryFiles).toEqual([]);
  expect(prepared.skippedScaffold).toEqual(["asset"]);
  expect(await Bun.file(join(f.request.appRoot, "asset")).text()).toBe("owned");
});

test("blocks raw secrets in invalid UTF-8 before the pipeline commits anything", async () => {
  // Given
  const f = await fixture(new Uint8Array([0xff, ...new TextEncoder().encode("raw-secret-marker"), 0xfe]), {
    secret: "raw-secret-marker",
  });
  // When
  const result = await Effect.runPromise(Effect.result(prepareRecipeInit(f.request)));
  // Then
  expect(Result.isFailure(result) && result.failure).toMatchObject({ stage: "validate" });
  expect(await readdir(f.root)).toEqual(["asset"]);
  expect(JSON.stringify(result)).not.toContain("raw-secret-marker");
});

test("blocks malformed explicit template bytes before committing the Landofile", async () => {
  // Given
  const f = await fixture(new Uint8Array([0xc3, 0x28]), { template: true });
  // When
  const result = await Effect.runPromise(Effect.result(prepareRecipeInit(f.request)));
  // Then
  expect(Result.isFailure(result) && result.failure).toMatchObject({ stage: "validate" });
  expect(await readdir(f.root)).toEqual(["asset"]);
});

test("publishes prepared static bytes when the source changes after preparation", async () => {
  // Given
  const bytes = new Uint8Array([0, 255, 128]);
  const f = await fixture(bytes);
  const prepared = await ready(f.request);
  await Bun.write(join(f.root, "asset"), "changed");
  // When
  const result = await Effect.runPromise(runRecipeInitPipeline({ ...f.publication, prepared }));
  // Then
  expect(await Bun.file(result.auxiliaryFiles[0] ?? "").bytes()).toEqual(bytes);
});
