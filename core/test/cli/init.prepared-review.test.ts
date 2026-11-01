import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PromptSpec } from "@lando/sdk/schema";
import type { LandoEvent } from "@lando/sdk/services";
import { Effect } from "effect";
import type { InitAppOptions } from "../../src/cli/commands/init-options.ts";
import { prepareInitApp } from "../../src/cli/commands/init-preparation.ts";
import { initAppWithProcessRunner as initApp } from "../_support/private-file-access.ts";
import { ownerOnlyFileAccess } from "../_support/private-file-access.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
const fixture = async () => {
  const root = await mkdtemp(join(tmpdir(), "init-prepared-hook-"));
  roots.push(root);
  const events: LandoEvent[] = [];
  let confirmations = 0;
  const interaction = {
    promptAll: async (prompts: readonly PromptSpec[]) =>
      prompts.some(({ name }) => name === "__recipe__") ? { __recipe__: "toolbox" } : { name: "reviewed" },
    confirm: async () => {
      confirmations++;
      return false;
    },
    select: async (): Promise<never> => {
      throw new Error("Unexpected selection");
    },
  };
  const options: InitAppOptions = {
    cwd: root,
    recipe: "toolbox",
    full: false,
    destination: join(root, "output"),
    userDataRoot: join(root, "state"),
    privateFileAccess: ownerOnlyFileAccess,
    runPostInit: false,
    interaction,
    events: {
      publish: (event) =>
        Effect.sync(() => {
          events.push(event);
        }),
    },
  };
  return { root, options, interaction, events, confirmations: () => confirmations };
};

test("shares the questionnaire prompter and signal while withholding all progress and publication during review", async () => {
  // Given
  const f = await fixture();
  const controller = new AbortController();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  // When
  const completion = initApp({
    ...f.options,
    signal: controller.signal,
    onPrepared: async (review, context) => {
      expect(context.interaction).toBe(f.interaction);
      expect(context.signal).toBe(controller.signal);
      expect(review).toMatchObject({ appName: "reviewed", appRoot: f.options.destination });
      expect(await context.interaction.confirm({ name: "skip", message: "skip", default: false })).toBe(
        false,
      );
      entered.resolve();
      await release.promise;
    },
  });
  await entered.promise;
  try {
    expect(f.events).toEqual([]);
    expect(await readdir(f.root)).toEqual([]);
  } finally {
    release.resolve();
  }
  const result = await completion;
  // Then
  expect(f.confirmations()).toBe(1);
  expect(f.events[0]?._tag).toBe("task.tree.start");
  expect(f.events.at(-1)?._tag).toBe("task.tree.complete");
  expect(await Bun.file(join(result.directory, ".lando.yml")).text()).toBe(result.preview.landofile);
});

test("propagates callback rejection by identity without creating progress or files", async () => {
  // Given
  const f = await fixture();
  const sentinel = new TypeError("review rejected");
  // When
  const completion = initApp({
    ...f.options,
    onPrepared: async () => {
      throw sentinel;
    },
  });
  // Then
  await expect(completion).rejects.toBe(sentinel);
  expect(await readdir(f.root)).toEqual([]);
  expect(f.events).toEqual([]);
});

test("aborts the review callback before progress or publication and supplies a cancellable signal", async () => {
  // Given
  const f = await fixture();
  const controller = new AbortController();
  const entered = Promise.withResolvers<void>();
  const stopped = Promise.withResolvers<void>();
  const completion = initApp({
    ...f.options,
    signal: controller.signal,
    onPrepared: async (_review, { signal }) => {
      if (signal === undefined) throw new Error("Missing review signal");
      try {
        await new Promise<void>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
          entered.resolve();
        });
      } finally {
        stopped.resolve();
      }
    },
  }).then(
    () => "success",
    () => "interrupted",
  );
  await entered.promise;
  // When
  controller.abort();
  // Then
  expect(await completion).toBe("interrupted");
  await stopped.promise;
  expect(await readdir(f.root)).toEqual([]);
  expect(f.events).toEqual([]);
});

test.each([
  { yes: true },
  { nonInteractive: true },
  { yes: true, nonInteractive: true },
  { name: "reviewed" },
])("suppresses review when human input is unnecessary: %j", async (mode) => {
  // Given
  const f = await fixture();
  let reviews = 0;
  // When
  await initApp({
    ...f.options,
    ...mode,
    onPrepared: async () => {
      reviews++;
    },
  });
  // Then
  expect(reviews).toBe(0);
  expect(f.events[0]?._tag).toBe("task.tree.start");
});

test("recipe selection makes review eligible even when the app name is supplied", async () => {
  // Given
  const f = await fixture();
  const { recipe: _recipe, ...options } = f.options;
  // When
  const result = await prepareInitApp({ ...options, name: "reviewed" });
  // Then
  expect(result.reviewEligible).toBe(true);
  expect(result.interaction).toBe(f.interaction);
  expect(await readdir(f.root)).toEqual([]);
});
