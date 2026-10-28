import { afterEach, expect, test } from "bun:test";
import { lstat, mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { plugin } from "@lando/lando4";
import { makeManagedFileTransactions } from "@lando/managed-file/transaction";
import { Effect, Result } from "effect";
import { recipeAssetDigest } from "../../src/recipes/builtin/snapshot-asset.ts";
import { runRecipeInitPipeline } from "../../src/recipes/init-pipeline.ts";
import { prepareRecipeInit } from "../../src/recipes/prepared-init.ts";
import { ownerOnlyFileAccess } from "../_support/private-file-access.ts";
import { compileTestSource, prepareTestSource, testSource } from "./fixtures/prepared-source.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
const fixture = async () => {
  const root = await mkdtemp(join(tmpdir(), "recipe-prepared-"));
  roots.push(root);
  const sourceRoot = join(root, "source");
  await mkdir(sourceRoot);
  const binary = new Uint8Array([0, 255, 128, 7]);
  await Bun.write(join(sourceRoot, "binary"), binary);
  await Bun.write(join(sourceRoot, "template"), "\uFEFF{{ app.name }}\n");
  const source = {
    ...testSource,
    files: [
      { src: "binary", dest: "assets/raw.bin" },
      { src: "template", dest: "bin/run", template: true, mode: "0755" },
    ],
    postInit: [{ type: "message", text: "ready" }],
  };
  return {
    root,
    sourceRoot,
    source,
    binary,
    appRoot: join(root, "destination"),
    journalRoot: () => join(root, "journals"),
  };
};

test("preparation is read-only and publishes exactly its frozen bytes and modes in one receipt", async () => {
  // Given
  const f = await fixture();
  const prepared = await prepareTestSource(f.source, f.sourceRoot, f.appRoot);
  const before = await readdir(f.root);
  await Bun.write(join(f.sourceRoot, "binary"), "changed after observation");
  prepared.outputs[1]?.content.fill(33);
  // When
  const calls: string[] = [];
  const result = await Effect.runPromise(
    runRecipeInitPipeline({
      prepared,
      journalRoot: f.journalRoot,
      privateFileAccess: ownerOnlyFileAccess,
      checkpoint: (point) =>
        Effect.sync(() => {
          if (point === "committed") calls.push("commit");
        }),
      runPostInit: async () => {
        calls.push("postInit");
        return { executed: [{ index: 0, type: "message" }] };
      },
    }),
  );
  // Then
  expect(before).toEqual(["source"]);
  expect(calls).toEqual(["commit", "postInit"]);
  expect(result.receipt.created.map(({ path }) => path)).toEqual([".lando.yml", "assets/raw.bin", "bin/run"]);
  expect(await Bun.file(join(f.appRoot, "assets/raw.bin")).bytes()).toEqual(f.binary);
  for (const output of prepared.outputs) {
    const bytes = await Bun.file(join(f.appRoot, output.destination)).bytes();
    expect(recipeAssetDigest(bytes)).toBe(output.digest);
    if (process.platform !== "win32")
      expect((await lstat(join(f.appRoot, output.destination))).mode & 0o777).toBe(output.mode);
  }
  expect(await Bun.file(join(f.appRoot, ".lando.yml")).text()).toBe(prepared.preview.landofile);
  expect(await Bun.file(join(f.appRoot, "bin/run")).bytes()).toEqual(
    new TextEncoder().encode("\uFEFFprepared\n"),
  );
});

test("missing answers are readiness and false defaults remain typed", async () => {
  // Given
  const f = await fixture();
  const compiled = await compileTestSource(
    {
      ...testSource,
      options: {
        required: { type: { kind: "string" } },
        enabled: { type: { kind: "boolean" }, default: false },
      },
    },
    f.sourceRoot,
  );
  const loader = plugin.configTranslators?.get("lando4");
  if (loader === undefined) throw new Error("Missing encoder");
  const encoder = await loader();
  // When
  const missing = await Effect.runPromise(
    prepareRecipeInit({ compiled, appRoot: f.appRoot, appName: "prepared", answers: {}, encoder }),
  );
  const ready = await Effect.runPromise(
    prepareRecipeInit({
      compiled,
      appRoot: f.appRoot,
      appName: "prepared",
      answers: { required: "answer" },
      encoder,
    }),
  );
  // Then
  expect(missing).toEqual({ status: "requires-input", missing: ["required"] });
  expect(ready).toMatchObject({ status: "ready", answers: { enabled: false, required: "answer" } });
  expect(await readdir(f.root)).toEqual(["source"]);
});

test("known auxiliary conflict skips the whole set and effectful actions", async () => {
  // Given
  const f = await fixture();
  await mkdir(join(f.appRoot, "assets"), { recursive: true });
  await Bun.write(join(f.appRoot, "assets/raw.bin"), "owned");
  const source = {
    ...f.source,
    postInit: [
      { type: "bun", verb: "install" },
      { type: "message", text: "ready" },
    ],
  };
  // When
  const prepared = await prepareTestSource(source, f.sourceRoot, f.appRoot);
  const result = await Effect.runPromise(
    runRecipeInitPipeline({
      prepared,
      journalRoot: f.journalRoot,
      privateFileAccess: ownerOnlyFileAccess,
      runPostInit: async ({ actions }) => ({ executed: actions.map(({ type }) => ({ index: 0, type })) }),
    }),
  );
  // Then
  expect(prepared.skippedScaffold).toEqual(["assets/raw.bin", "bin/run"]);
  expect(result.receipt.written).toEqual([".lando.yml"]);
  expect(result.postInit.executed.map(({ type }) => type)).toEqual(["message"]);
  expect(await Bun.file(join(f.appRoot, "assets/raw.bin")).text()).toBe("owned");
  expect(await Bun.file(join(f.appRoot, "bin/run")).exists()).toBe(false);
});

test("late conflict retains truthful transaction state without clobbering or running post-init", async () => {
  // Given
  const f = await fixture();
  const prepared = await prepareTestSource(f.source, f.sourceRoot, f.appRoot);
  let ran = false;
  // When
  const result = await Effect.runPromise(
    Effect.result(
      runRecipeInitPipeline({
        prepared,
        journalRoot: f.journalRoot,
        privateFileAccess: ownerOnlyFileAccess,
        checkpoint: (point, index) =>
          point === "before-create-link" && index === 1
            ? Effect.promise(async () => {
                await Bun.write(join(f.appRoot, "assets/raw.bin"), "competitor");
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
    phase: "commit",
    reason: "conflict",
    transactionState: "committing",
  });
  expect(await Bun.file(join(f.appRoot, "assets/raw.bin")).text()).toBe("competitor");
  expect(await Bun.file(join(f.appRoot, ".lando.yml")).exists()).toBe(true);
  expect(ran).toBe(false);
  const tx = makeManagedFileTransactions({
    journalRoot: f.journalRoot,
    privateFileAccess: ownerOnlyFileAccess,
  });
  expect((await Effect.runPromise(tx.readJournal(f.appRoot)))?.state).toBe("committing");
});

test.each([".lando.yml", ".lando.ts"])("known %s conflict blocks before publication", async (name) => {
  // Given
  const f = await fixture();
  await mkdir(f.appRoot);
  await Bun.write(join(f.appRoot, name), "owned");
  const prepared = await prepareTestSource(f.source, f.sourceRoot, f.appRoot);
  // When
  const result = await Effect.runPromise(
    Effect.result(
      runRecipeInitPipeline({ prepared, journalRoot: f.journalRoot, privateFileAccess: ownerOnlyFileAccess }),
    ),
  );
  // Then
  expect(Result.isFailure(result) && result.failure).toMatchObject({ _tag: "InitTargetExistsError" });
  expect(await readdir(f.appRoot)).toEqual([name]);
  expect(await readdir(f.root)).not.toContain("journals");
});

test.each([true, false])("changed scripts fail only when post-init is enabled (%s)", async (enabled) => {
  // Given
  const f = await fixture();
  await Bun.write(join(f.sourceRoot, "script.ts"), "export {};\n");
  const prepared = await prepareTestSource(
    { ...f.source, postInit: [{ type: "bun", verb: "script", script: "script.ts" }] },
    f.sourceRoot,
    f.appRoot,
  );
  let ran = false;
  // When
  const result = await Effect.runPromise(
    Effect.result(
      runRecipeInitPipeline({
        prepared,
        postInitEnabled: enabled,
        journalRoot: f.journalRoot,
        privateFileAccess: ownerOnlyFileAccess,
        checkpoint: (point) =>
          point === "committed"
            ? Effect.promise(async () => {
                await Bun.write(join(f.sourceRoot, "script.ts"), "throw new Error('drift');\n");
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
  expect(Result.isFailure(result)).toBe(enabled);
  if (Result.isFailure(result))
    expect(result.failure).toMatchObject({
      _tag: "RecipeInitPostInitError",
      rolledBack: false,
      failedAction: "postInit[0] (script changed)",
      remediation:
        "Inspect the named action and committed files before retrying. External effects are not recoverable by the static transaction.",
      committedLandofile: join(f.appRoot, ".lando.yml"),
      committedAuxiliaryFiles: [join(f.appRoot, "assets/raw.bin"), join(f.appRoot, "bin/run")],
    });
  expect(ran).toBe(false);
  expect(await Bun.file(join(f.appRoot, "assets/raw.bin")).bytes()).toEqual(f.binary);
});

test("a late sibling TypeScript Landofile blocks static publication", async () => {
  // Given
  const f = await fixture();
  const prepared = await prepareTestSource(f.source, f.sourceRoot, f.appRoot);
  // When
  const result = await Effect.runPromise(
    Effect.result(
      runRecipeInitPipeline({
        prepared,
        journalRoot: f.journalRoot,
        privateFileAccess: ownerOnlyFileAccess,
        checkpoint: (point) =>
          point === "prepared"
            ? Effect.promise(async () => {
                await Bun.write(join(f.appRoot, ".lando.ts"), "competitor");
              })
            : Effect.void,
      }),
    ),
  );
  // Then
  expect(Result.isFailure(result) && result.failure).toMatchObject({
    _tag: "RecipeInitCommitError",
    reason: "conflict",
  });
  expect(await Bun.file(join(f.appRoot, ".lando.ts")).text()).toBe("competitor");
  expect(await Bun.file(join(f.appRoot, ".lando.yml")).exists()).toBe(false);
});
