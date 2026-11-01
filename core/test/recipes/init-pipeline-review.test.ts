import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, rename, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Exit, Result } from "effect";
import { ownerOnlyFileAccess } from "../_support/private-file-access.ts";
import { runRecipeInitPipeline } from "../_support/recipe-pipeline.ts";
import { prepareTestSource, testSource } from "./fixtures/prepared-source.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
const fixture = async () => {
  const root = await mkdtemp(join(tmpdir(), "init-review-boundary-"));
  roots.push(root);
  await Bun.write(join(root, "asset"), "approved");
  const appRoot = join(root, "parent", "app");
  await mkdir(join(root, "parent"));
  const prepared = await prepareTestSource(
    {
      ...testSource,
      files: [{ src: "asset", dest: "nested/asset" }],
      postInit: [{ type: "message", text: "ready" }],
    },
    root,
    appRoot,
  );
  let childCalls = 0;
  return {
    root,
    appRoot,
    prepared,
    request: {
      prepared,
      privateFileAccess: ownerOnlyFileAccess,
      journalRoot: () => join(root, "journal"),
      runPostInit: async () => {
        childCalls++;
        return { executed: [] };
      },
    },
    childCalls: () => childCalls,
  };
};

test("awaits review before any destination, lock, journal, stage, or post-init work", async () => {
  // Given
  const f = await fixture();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const before = await readdir(f.root, { recursive: true });
  // When
  const completion = Effect.runPromise(
    runRecipeInitPipeline(f.request, () =>
      Effect.promise(async () => {
        entered.resolve();
        await release.promise;
      }),
    ),
  );
  await entered.promise;
  try {
    expect(await readdir(f.root, { recursive: true })).toEqual(before);
    expect(f.childCalls()).toBe(0);
  } finally {
    release.resolve();
  }
  const result = await completion;
  // Then
  expect(result.receipt.written).toEqual([".lando.yml", "nested/asset"]);
  expect(await Bun.file(join(f.appRoot, "nested/asset")).text()).toBe("approved");
});

test("preserves a generic hook failure by identity without publication", async () => {
  // Given
  const f = await fixture();
  const sentinel = { kind: "review-rejected" };
  const before = await readdir(f.root, { recursive: true });
  // When
  const result = await Effect.runPromise(
    Effect.result(runRecipeInitPipeline(f.request, () => Effect.fail(sentinel))),
  );
  // Then
  expect(Result.isFailure(result) && result.failure).toBe(sentinel);
  expect(await readdir(f.root, { recursive: true })).toEqual(before);
  expect(f.childCalls()).toBe(0);
});

test("interrupts a pending hook without publication or child work", async () => {
  // Given
  const f = await fixture();
  const controller = new AbortController();
  const entered = Promise.withResolvers<void>();
  const before = await readdir(f.root, { recursive: true });
  const completion = Effect.runPromiseExit(
    runRecipeInitPipeline(f.request, () =>
      Effect.gen(function* () {
        entered.resolve();
        yield* Effect.never;
      }),
    ),
    { signal: controller.signal },
  );
  await entered.promise;
  // When
  controller.abort();
  const result = await completion;
  // Then
  expect(Exit.isFailure(result)).toBe(true);
  expect(await readdir(f.root, { recursive: true })).toEqual(before);
  expect(f.childCalls()).toBe(0);
});

test.each(["nested/asset", ".lando.ts"])(
  "rejects late %s without broadening the approved create set",
  async (path) => {
    // Given
    const f = await fixture();
    // When
    const result = await Effect.runPromise(
      Effect.result(
        runRecipeInitPipeline(f.request, () =>
          Effect.promise(async () => {
            await mkdir(join(f.appRoot, "nested"), { recursive: true });
            await Bun.write(join(f.appRoot, path), "competitor");
          }),
        ),
      ),
    );
    // Then
    expect(Result.isFailure(result) && result.failure).toMatchObject({
      _tag: "RecipeInitCommitError",
      reason: "conflict",
    });
    expect(await Bun.file(join(f.appRoot, path)).text()).toBe("competitor");
    expect(await Bun.file(join(f.appRoot, ".lando.yml")).exists()).toBe(false);
    expect(f.childCalls()).toBe(0);
  },
);

test.each(["parent", "nested"])(
  "rejects a %s symlink swap during review without writing outside",
  async (parent) => {
    // Given
    const f = await fixture();
    const outside = join(f.root, "outside");
    await mkdir(outside);
    if (parent === "nested") await mkdir(join(f.appRoot, "nested"), { recursive: true });
    // When
    const result = await Effect.runPromise(
      Effect.result(
        runRecipeInitPipeline(f.request, () =>
          Effect.promise(async () => {
            const target = parent === "parent" ? join(f.root, "parent") : join(f.appRoot, "nested");
            await rename(target, `${target}-parked`);
            await symlink(outside, target);
          }),
        ),
      ),
    );
    // Then
    expect(Result.isFailure(result) && result.failure).toMatchObject({ _tag: "RecipeInitCommitError" });
    expect(await readdir(outside)).toEqual([]);
    expect(f.childCalls()).toBe(0);
  },
);

test("rejects a known conflict before invoking review", async () => {
  // Given
  const f = await fixture();
  await mkdir(f.appRoot);
  await Bun.write(join(f.appRoot, ".lando.yml"), "owned");
  const prepared = await prepareTestSource(testSource, f.root, f.appRoot);
  let reviewed = false;
  // When
  const result = await Effect.runPromise(
    Effect.result(
      runRecipeInitPipeline({ ...f.request, prepared }, () =>
        Effect.sync(() => {
          reviewed = true;
        }),
      ),
    ),
  );
  // Then
  expect(Result.isFailure(result) && result.failure).toMatchObject({ _tag: "InitTargetExistsError" });
  expect(reviewed).toBe(false);
});

test("rejects replacement of the observed destination parent by a different real directory", async () => {
  // Given
  const f = await fixture();
  // When
  const result = await Effect.runPromise(
    Effect.result(
      runRecipeInitPipeline(f.request, () =>
        Effect.promise(async () => {
          await rename(join(f.root, "parent"), join(f.root, "parked-parent"));
          await mkdir(join(f.root, "parent"));
        }),
      ),
    ),
  );
  // Then
  expect(Result.isFailure(result) && result.failure).toMatchObject({
    _tag: "RecipeInitCommitError",
    reason: "path",
  });
  expect(await readdir(join(f.root, "parent"))).toEqual([]);
  expect(f.childCalls()).toBe(0);
});

test("keeps the original whole-set skip when an occupied auxiliary file disappears during review", async () => {
  // Given
  const f = await fixture();
  await mkdir(join(f.appRoot, "nested"), { recursive: true });
  await Bun.write(join(f.appRoot, "nested/asset"), "owned");
  const prepared = await prepareTestSource(
    {
      ...testSource,
      files: [
        { src: "asset", dest: "nested/asset" },
        { src: "asset", dest: "second" },
      ],
    },
    f.root,
    f.appRoot,
  );
  // When
  const result = await Effect.runPromise(
    runRecipeInitPipeline({ ...f.request, prepared }, () =>
      Effect.promise(() => rm(join(f.appRoot, "nested/asset"))),
    ),
  );
  // Then
  expect(prepared.skippedScaffold).toEqual(["nested/asset", "second"]);
  expect(result.receipt.written).toEqual([".lando.yml"]);
  expect(result.auxiliaryFiles).toEqual([]);
});
