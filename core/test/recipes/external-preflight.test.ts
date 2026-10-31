import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { ownerOnlyFileAccess } from "../_support/private-file-access.ts";
import { runRecipeInitPipeline } from "../_support/recipe-pipeline.ts";
import { prepareTestSource, testSource } from "./fixtures/prepared-source.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

test("pipeline publishes preflighted bytes even when the source changes after commit", async () => {
  // Given
  const root = await realpath(await mkdtemp(join(tmpdir(), "external-preflight-")));
  roots.push(root);
  const appRoot = join(root, "app");
  await mkdir(appRoot);
  const sourceRoot = join(root, "recipe");
  const bytes = new Uint8Array([0x00, 0x89, 0x50, 0xff, 0xfe]);
  await Bun.write(join(sourceRoot, "asset.bin"), bytes);
  const prepared = await prepareTestSource(
    { ...testSource, files: [{ src: "asset.bin", dest: "asset.bin" }] },
    sourceRoot,
    appRoot,
  );
  // When
  const result = await Effect.runPromise(
    runRecipeInitPipeline({
      prepared,
      journalRoot: () => join(root, "journal"),
      privateFileAccess: ownerOnlyFileAccess,
      checkpoint: (point) =>
        point === "committed"
          ? Effect.promise(async () => {
              await Bun.write(join(sourceRoot, "asset.bin"), "replacement bytes");
            })
          : Effect.void,
    }),
  );
  // Then
  expect(result.auxiliaryFiles).toEqual([join(appRoot, "asset.bin")]);
  expect(new Uint8Array(await Bun.file(join(appRoot, "asset.bin")).arrayBuffer())).toEqual(bytes);
});
