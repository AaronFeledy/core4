import { expect, spyOn, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ResolveIncludesError } from "@lando/landofile/includes";
import type { StateStore } from "@lando/sdk/services";
import { Effect } from "effect";
import {
  type loadLandofileFile,
  type loadLandofileLayers,
  resolveLandofileIncludes,
  updateLandofileIncludes,
  verifyLandofileIncludes,
} from "../../src/services/landofile-live.ts";
import { makeTestStateStore } from "../../src/testing/state-store.ts";

test("requires StateStore in every engine Landofile wrapper environment", () => {
  // Given the inferred environments of all five wrappers
  type RequiresStore<F extends (...args: never[]) => Effect.Effect<unknown, unknown, unknown>> =
    StateStore extends Effect.Effect.Context<ReturnType<F>> ? true : false;
  const requirements = {
    resolve: true satisfies RequiresStore<typeof resolveLandofileIncludes>,
    update: true satisfies RequiresStore<typeof updateLandofileIncludes>,
    verify: true satisfies RequiresStore<typeof verifyLandofileIncludes>,
    file: true satisfies RequiresStore<typeof loadLandofileFile>,
    layers: true satisfies RequiresStore<typeof loadLandofileLayers>,
  };
  // When TypeScript checks the environment contract
  // Then none of the wrappers erase the required service
  expect(Object.values(requirements)).toEqual([true, true, true, true, true]);
});

const operations = [
  ["resolve", resolveLandofileIncludes],
  ["update", updateLandofileIncludes],
  ["verify", verifyLandofileIncludes],
] as const;

test.each(operations)(
  "%s reads the ambient StateStore when no explicit store is supplied",
  async (_name, run) => {
    // Given a local include and a fresh ambient store
    const appRoot = await mkdtemp(join(tmpdir(), "lando-include-store-"));
    const store = makeTestStateStore();
    const open = spyOn(store.service, "open");
    try {
      await writeFile(join(appRoot, "fragment.yml"), "lando: '>=4'\n");
      // When the engine wrapper resolves its dependency from Effect
      await Effect.runPromise(
        Effect.asVoid<unknown, ResolveIncludesError, StateStore>(
          run({
            appRoot,
            cacheRoot: join(appRoot, ".cache"),
            landofile: { includes: ["./fragment.yml"] },
          }),
        ).pipe(Effect.provide(store.layer)),
      );
      // Then lockfile access uses that store
      expect(open).toHaveBeenCalled();
    } finally {
      open.mockRestore();
      await rm(appRoot, { recursive: true, force: true });
    }
  },
);

test.each(operations)("%s prefers the explicit StateStore over the ambient store", async (_name, run) => {
  // Given distinct explicit and ambient stores
  const appRoot = await mkdtemp(join(tmpdir(), "lando-include-store-precedence-"));
  const explicit = makeTestStateStore();
  const ambient = makeTestStateStore();
  const explicitOpen = spyOn(explicit.service, "open");
  const ambientOpen = spyOn(ambient.service, "open");
  try {
    await writeFile(join(appRoot, "fragment.yml"), "lando: '>=4'\n");
    // When both injection paths are available
    await Effect.runPromise(
      Effect.asVoid<unknown, ResolveIncludesError, StateStore>(
        run({
          appRoot,
          cacheRoot: join(appRoot, ".cache"),
          landofile: { includes: ["./fragment.yml"] },
          stateStore: explicit.service,
        }),
      ).pipe(Effect.provide(ambient.layer)),
    );
    // Then only the explicitly supplied store is opened
    expect(explicitOpen).toHaveBeenCalled();
    expect(ambientOpen).not.toHaveBeenCalled();
  } finally {
    explicitOpen.mockRestore();
    ambientOpen.mockRestore();
    await rm(appRoot, { recursive: true, force: true });
  }
});
