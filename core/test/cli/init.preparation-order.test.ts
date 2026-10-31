import { afterEach, expect, spyOn, test } from "bun:test";
import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { loadRecipeEncoder, prepareInitApp } from "../../src/cli/commands/init-preparation.ts";
import * as decomposer from "../../src/recipes/compiled-decomposer.ts";
import * as assets from "../../src/recipes/init-pipeline/files.ts";
import { initAppWithProcessRunner as initApp } from "../_support/private-file-access.ts";
import { ownerOnlyFileAccess } from "../_support/private-file-access.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

test.each([
  { secret: false, supplied: false },
  { secret: true, supplied: false },
  { secret: false, supplied: true },
])("collects all answers before one encoding and one asset observation: %j", async ({ secret, supplied }) => {
  // Given
  const root = await mkdtemp(join(tmpdir(), "init-preparation-order-"));
  roots.push(root);
  const recipe = join(root, "ordering");
  await mkdir(recipe);
  await Bun.write(join(recipe, "asset"), "before questionnaire");
  await Bun.write(
    join(recipe, "recipe.yml"),
    `id: ordering
title: Ordering
description: Ordering fixture
version: 1.0.0
options:
  flavor:
    type:
      kind: string
    default: initial
${secret ? "  token:\n    type:\n      kind: secret\n    disposition:\n      kind: init-only\n      sink:\n        kind: stdin\n" : ""}config:
  runtime: 4
files:
  - src: asset
    dest: asset
${secret ? "postInit:\n  - type: bun\n    verb: install\n    stdin:\n      prompt: token\n" : ""}`,
  );
  const encoder = await loadRecipeEncoder();
  const encode = encoder.encode;
  if (encode === undefined) throw new Error("Missing encoder");
  let invocations = 0;
  let approved = "";
  let reviews = 0;
  const encoderSpy = spyOn(encoder, "encode").mockImplementation((input) =>
    Effect.map(encode(input), (result) => ({
      ...result,
      text: `${result.text}\n# invocation ${++invocations}\n`,
    })),
  );
  const decomposeSpy = spyOn(decomposer, "makeCompiledRecipeDecomposer");
  const assetSpy = spyOn(assets, "readAuxiliaryScaffoldContent");
  try {
    // When
    const result = await initApp({
      cwd: root,
      recipe,
      full: false,
      name: "ordered",
      destination: join(root, "output"),
      userDataRoot: join(root, "state"),
      privateFileAccess: ownerOnlyFileAccess,
      runPostInit: false,
      ...(supplied ? { answers: { flavor: "final" } } : {}),
      interaction: {
        promptAll: async (_prompts, options) => {
          expect(encoderSpy).toHaveBeenCalledTimes(0);
          expect(decomposeSpy).toHaveBeenCalledTimes(0);
          expect(assetSpy).toHaveBeenCalledTimes(0);
          await Bun.write(join(recipe, "asset"), "first observation");
          return {
            ...options?.answers,
            name: "ordered",
            flavor: "final",
            ...(secret ? { token: "PRIVATE_ORDER_CANARY" } : {}),
          };
        },
        confirm: async () => false,
        select: async () => {
          throw new Error("Unexpected selection");
        },
      },
      onPrepared: async (review) => {
        reviews++;
        const output = review.outputs.find(({ destination }) => destination === ".lando.yml");
        approved = output?.digest ?? "";
        await Bun.write(join(recipe, "asset"), "changed during review");
      },
    });
    // Then
    expect(encoderSpy).toHaveBeenCalledTimes(1);
    expect(decomposeSpy).toHaveBeenCalledTimes(1);
    expect(assetSpy).toHaveBeenCalledTimes(1);
    expect(result.answers.flavor).toBe("final");
    expect(reviews).toBe(supplied ? 0 : 1);
    if (!supplied)
      expect(result.preview.outputs.find(({ destination }) => destination === ".lando.yml")?.digest).toBe(
        approved,
      );
    expect(await Bun.file(join(result.directory, ".lando.yml")).text()).toBe(result.preview.landofile);
    expect(await Bun.file(join(result.directory, "asset")).text()).toBe("first observation");
  } finally {
    encoderSpy.mockRestore();
    decomposeSpy.mockRestore();
    assetSpy.mockRestore();
  }
});

test("does not observe recipe assets when questionnaire cancellation rejects", async () => {
  // Given
  const root = await mkdtemp(join(tmpdir(), "init-cancel-before-assets-"));
  roots.push(root);
  const recipe = join(root, "unread");
  await mkdir(recipe);
  await Bun.write(join(recipe, "absent"), "unread bytes");
  await Bun.write(
    join(recipe, "recipe.yml"),
    "id: unread\ntitle: Unread\ndescription: Unread\nversion: 1.0.0\nconfig:\n  runtime: 4\nfiles:\n  - src: absent\n    dest: asset\n",
  );
  const sentinel = new TypeError("cancel");
  const assetSpy = spyOn(assets, "readAuxiliaryScaffoldContent");
  // When
  const completion = prepareInitApp({
    cwd: root,
    recipe,
    full: false,
    privateFileAccess: ownerOnlyFileAccess,
    interaction: {
      promptAll: async () => {
        throw sentinel;
      },
      confirm: async () => false,
      select: async () => {
        throw new Error("Unexpected selection");
      },
    },
  });
  // Then
  try {
    await expect(completion).rejects.toBe(sentinel);
    expect(assetSpy).toHaveBeenCalledTimes(0);
  } finally {
    assetSpy.mockRestore();
  }
  expect(await readdir(root)).toEqual(["unread"]);
});
