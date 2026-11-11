import { describe, expect, test } from "bun:test";
import { mkdtemp, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AbsolutePath } from "@lando/core/schema";
import { ScratchAppService } from "@lando/core/services";
import { Effect } from "effect";

import { makeLandoRuntime } from "../../src/runtime/layer.ts";
import { withCwd, withEnvVar } from "../_support/temp-cwd.ts";

/** Build after env roots are injected so PathsService honors the test data root. */
const scratchAppLayer = () => makeLandoRuntime({ bootstrap: "scratch" });

const withTempRoots = async <T>(
  run: (roots: { readonly dataRoot: string; readonly cacheRoot: string }) => Promise<T>,
): Promise<T> => {
  const dataRoot = await realpath(await mkdtemp(join(tmpdir(), "lando-scratch-data-")));
  const cacheRoot = await realpath(await mkdtemp(join(tmpdir(), "lando-scratch-cache-")));
  try {
    return await withEnvVar("LANDO_USER_DATA_ROOT", dataRoot, () =>
      withEnvVar("LANDO_USER_CACHE_ROOT", cacheRoot, () => run({ dataRoot, cacheRoot })),
    );
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
    await rm(cacheRoot, { recursive: true, force: true });
  }
};

const directoryExists = async (path: string): Promise<boolean> => {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
};

const withTempCwd = async <T>(run: (dir: string) => Promise<T>): Promise<T> => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "lando-scratch-empty-cwd-")));
  try {
    return await withCwd(dir, () => run(dir), [dir]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
};

describe("ScratchAppServiceLayer.layer", () => {
  test("resolves the scratch base under the user data root", async () => {
    await withTempRoots(async ({ dataRoot }) => {
      const resolved = await Effect.runPromise(
        Effect.flatMap(ScratchAppService, (service) => service.root).pipe(Effect.provide(scratchAppLayer())),
      );
      expect(resolved).toBe(AbsolutePath.make(join(dataRoot, "scratch")));
    });
  });

  test("ensureRoot materializes the scratch base idempotently", async () => {
    await withTempRoots(async ({ dataRoot }) => {
      const program = Effect.scoped(Effect.flatMap(ScratchAppService, (service) => service.ensureRoot));
      const first = await Effect.runPromise(program.pipe(Effect.provide(scratchAppLayer())));
      const second = await Effect.runPromise(program.pipe(Effect.provide(scratchAppLayer())));
      expect(first).toBe(AbsolutePath.make(join(dataRoot, "scratch")));
      expect(second).toBe(first);
      expect(await directoryExists(join(dataRoot, "scratch"))).toBe(true);
    });
  });

  test("synthesizeId emits a unique scratch-<base>-<6hex> id", async () => {
    await withTempRoots(async () => {
      const program = Effect.flatMap(ScratchAppService, (service) =>
        Effect.all([service.synthesizeId("My App"), service.synthesizeId("My App")]),
      );
      const [first, second] = await Effect.runPromise(program.pipe(Effect.provide(scratchAppLayer())));
      expect(first).toMatch(/^scratch-my-app-[0-9a-f]{6}$/u);
      expect(second).toMatch(/^scratch-my-app-[0-9a-f]{6}$/u);
      expect(first).not.toBe(second);
    });
  });

  test("paths lays out the scratch instance directories", async () => {
    await withTempRoots(async ({ dataRoot }) => {
      const resolved = await Effect.runPromise(
        Effect.flatMap(ScratchAppService, (service) => service.paths("scratch-lamp-abc123")).pipe(
          Effect.provide(scratchAppLayer()),
        ),
      );
      const base = AbsolutePath.make(join(dataRoot, "scratch"));
      const instanceRoot = AbsolutePath.make(join(base, "scratch-lamp-abc123"));
      expect(resolved).toEqual({
        base,
        instanceRoot,
        root: AbsolutePath.make(join(instanceRoot, "root")),
        planCache: AbsolutePath.make(join(instanceRoot, "plan.bin")),
      });
    });
  });

  test("paths rejects ids that would escape the scratch namespace", async () => {
    await withTempRoots(async () => {
      for (const unsafe of ["..", ".", "../../etc", "a/b", "a\\b", ""]) {
        const result = await Effect.runPromise(
          Effect.flatMap(ScratchAppService, (service) => service.paths(unsafe)).pipe(
            Effect.provide(scratchAppLayer()),
            Effect.result,
          ),
        );
        expect(result._tag).toBe("Failure");
        if (result._tag === "Failure") expect(result.failure._tag).toBe("ScratchAppError");
      }
    });
  });

  test("current lifecycle seam returns honest source, empty, and not-found outcomes", async () => {
    await withTempRoots(async () => {
      await withTempCwd(async () => {
        const program = Effect.gen(function* () {
          const service = yield* ScratchAppService;
          const acquired = yield* Effect.scoped(
            service.acquire({ source: { kind: "fork" }, detached: true }),
          ).pipe(Effect.result);
          const listed = yield* service.list();
          const gc = yield* service.gc({ prune: true });
          const resolved = yield* service.resolveById("scratch-nope-000000").pipe(Effect.result);
          const started = yield* service.start("scratch-nope-000000", { detach: true }).pipe(Effect.result);
          const stopped = yield* service.stop("scratch-nope-000000").pipe(Effect.result);
          const destroyed = yield* service
            .destroy("scratch-nope-000000", { keepVolumes: true })
            .pipe(Effect.result);
          return { acquired, listed, gc, resolved, started, stopped, destroyed };
        });

        const result = await Effect.runPromise(program.pipe(Effect.provide(scratchAppLayer())));
        expect(result.acquired._tag).toBe("Failure");
        if (result.acquired._tag === "Failure")
          expect(result.acquired.failure._tag).toBe("ScratchSourceUnresolvedError");
        expect(result.listed).toEqual([]);
        expect(result.gc).toEqual({ inspected: 0, reaped: [], errors: [] });
        for (const outcome of [result.resolved, result.started, result.stopped, result.destroyed]) {
          expect(outcome._tag).toBe("Failure");
          if (outcome._tag === "Failure") expect(outcome.failure._tag).toBe("ScratchAppNotFoundError");
        }
      });
    });
  });

  test("the scratch bootstrap runtime tier provides ScratchAppService", async () => {
    await withTempRoots(async ({ dataRoot }) => {
      const runtime = makeLandoRuntime({ bootstrap: "scratch" });
      const resolved = await Effect.runPromise(
        Effect.flatMap(ScratchAppService, (service) => service.root).pipe(Effect.provide(runtime)),
      );
      expect(resolved).toBe(AbsolutePath.make(join(dataRoot, "scratch")));
    });
  });
});
