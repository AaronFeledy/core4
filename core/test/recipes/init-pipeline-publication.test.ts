import { afterEach, expect, test } from "bun:test";
import { lstat, mkdir, mkdtemp, rename, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Result } from "effect";
import { ownerOnlyFileAccess } from "../_support/private-file-access.ts";
import { runRecipeInitPipeline } from "../_support/recipe-pipeline.ts";
import { prepareTestSource, testSource } from "./fixtures/prepared-source.ts";

const roots: string[] = [];
const temporary = async () => {
  const root = await mkdtemp(join(tmpdir(), "init-publication-"));
  roots.push(root);
  return root;
};
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
const fixture = async (destination = "asset") => {
  const root = await temporary();
  await Bun.write(join(root, "source"), "new bytes");
  const appRoot = join(root, "app");
  await mkdir(appRoot);
  const source = { ...testSource, files: [{ src: "source", dest: destination }] };
  const publication = { privateFileAccess: ownerOnlyFileAccess, journalRoot: () => join(root, "journal") };
  return { root, appRoot, source, publication };
};

test("preserves another writer's bytes when the destination appears before preparation", async () => {
  // Given
  const f = await fixture();
  await Bun.write(join(f.appRoot, "asset"), "existing bytes");
  // When
  const prepared = await prepareTestSource(f.source, f.root, f.appRoot);
  const result = await Effect.runPromise(runRecipeInitPipeline({ ...f.publication, prepared }));
  // Then
  expect(await Bun.file(join(f.appRoot, "asset")).text()).toBe("existing bytes");
  expect(result.auxiliaryFiles).toEqual([]);
});

test.each(["file", "directory", "symlink", "dangling"] as const)(
  "skips an occupied %s auxiliary destination",
  async (kind) => {
    // Given
    const f = await fixture();
    const path = join(f.appRoot, "asset");
    const target = join(f.appRoot, "target");
    switch (kind) {
      case "file":
        await Bun.write(path, "old");
        break;
      case "directory":
        await mkdir(path);
        break;
      case "symlink":
        await Bun.write(target, "old");
        await symlink(target, path);
        break;
      case "dangling":
        await symlink(target, path);
        break;
      default:
        kind satisfies never;
    }
    const before = await lstat(path);
    // When
    const prepared = await prepareTestSource(f.source, f.root, f.appRoot);
    const result = await Effect.runPromise(runRecipeInitPipeline({ ...f.publication, prepared }));
    // Then
    expect(result.auxiliaryFiles).toEqual([]);
    expect((await lstat(path)).ino).toBe(before.ino);
  },
);

test.each([true, false])("refuses a destination parent symlink (dangling=%s)", async (dangling) => {
  // Given
  const f = await fixture("parent/asset");
  const outside = await temporary();
  await symlink(dangling ? join(outside, "missing") : outside, join(f.appRoot, "parent"));
  // When
  const result = await prepareTestSource(f.source, f.root, f.appRoot).then(
    () => "success",
    () => "failure",
  );
  // Then
  expect(result).toBe("failure");
  expect(await Bun.file(join(outside, "asset")).exists()).toBe(false);
});

test("fails without clobbering when another writer wins the exclusive-link boundary", async () => {
  // Given
  const f = await fixture();
  const prepared = await prepareTestSource(f.source, f.root, f.appRoot);
  // When
  const result = await Effect.runPromise(
    Effect.result(
      runRecipeInitPipeline({
        ...f.publication,
        prepared,
        checkpoint: (point, index) =>
          point === "before-create-link" && index === 1
            ? Effect.promise(async () => {
                await Bun.write(join(f.appRoot, "asset"), "race winner");
              })
            : Effect.void,
      }),
    ),
  );
  // Then
  expect(Result.isFailure(result) && result.failure).toMatchObject({
    reason: "conflict",
    transactionState: "committing",
  });
  expect(await Bun.file(join(f.appRoot, "asset")).text()).toBe("race winner");
});

test.each(["prepared", "before-create-link"] as const)(
  "rejects a parent swapped for an outside symlink at %s",
  async (boundary) => {
    // Given
    const f = await fixture("parent/asset");
    const outside = await temporary();
    const parent = join(f.appRoot, "parent");
    await mkdir(parent);
    await Bun.write(join(outside, "asset"), "outside bytes");
    const prepared = await prepareTestSource(f.source, f.root, f.appRoot);
    // When
    const result = await Effect.runPromise(
      Effect.result(
        runRecipeInitPipeline({
          ...f.publication,
          prepared,
          checkpoint: (point, index) =>
            point === boundary && (point === "prepared" || index === 1)
              ? Effect.promise(async () => {
                  await rename(parent, join(f.appRoot, "parked"));
                  await symlink(outside, parent);
                })
              : Effect.void,
        }),
      ),
    );
    // Then
    expect(Result.isFailure(result)).toBe(true);
    expect(await Bun.file(join(outside, "asset")).text()).toBe("outside bytes");
  },
);

test.each(["../escape", "/absolute", "."])("rejects destination escape %s", async (destination) => {
  // Given
  const f = await fixture(destination);
  // When
  const result = await prepareTestSource(f.source, f.root, f.appRoot).then(
    () => "success",
    () => "failure",
  );
  // Then
  expect(result).toBe("failure");
  expect(await Bun.file(join(f.appRoot, ".lando.yml")).exists()).toBe(false);
});
