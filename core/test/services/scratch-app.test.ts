import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Layer } from "effect";

import { ScratchAppService } from "@lando/core/services";

import { makeLandoRuntime } from "../../src/runtime/layer.ts";
import { ScratchAppServiceLive } from "../../src/scratch-app/service.ts";
import { FileSystemLive } from "../../src/services/file-system.ts";

const scratchAppLayer = ScratchAppServiceLive.pipe(Layer.provide(FileSystemLive));

const withTempCacheRoot = async <T>(run: (cacheRoot: string) => Promise<T>): Promise<T> => {
  const cacheRoot = await mkdtemp(join(tmpdir(), "lando-scratch-cache-"));
  const previous = process.env.LANDO_USER_CACHE_ROOT;
  try {
    process.env.LANDO_USER_CACHE_ROOT = cacheRoot;
    return await run(cacheRoot);
  } finally {
    // biome-ignore lint/performance/noDelete: env delete avoids Bun coercing undefined to "undefined".
    if (previous === undefined) delete process.env.LANDO_USER_CACHE_ROOT;
    else process.env.LANDO_USER_CACHE_ROOT = previous;
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

describe("ScratchAppServiceLive", () => {
  test("resolves the scratch base under the user cache root", async () => {
    await withTempCacheRoot(async (cacheRoot) => {
      const resolved = await Effect.runPromise(
        Effect.flatMap(ScratchAppService, (service) => service.root).pipe(Effect.provide(scratchAppLayer)),
      );
      expect(resolved).toBe(join(cacheRoot, "scratch"));
    });
  });

  test("ensureRoot materializes the scratch base idempotently", async () => {
    await withTempCacheRoot(async (cacheRoot) => {
      const program = Effect.scoped(Effect.flatMap(ScratchAppService, (service) => service.ensureRoot));
      const first = await Effect.runPromise(program.pipe(Effect.provide(scratchAppLayer)));
      const second = await Effect.runPromise(program.pipe(Effect.provide(scratchAppLayer)));
      expect(first).toBe(join(cacheRoot, "scratch"));
      expect(second).toBe(first);
      expect(await directoryExists(join(cacheRoot, "scratch"))).toBe(true);
    });
  });

  test("synthesizeId emits a unique scratch-<base>-<6hex> id", async () => {
    await withTempCacheRoot(async () => {
      const program = Effect.flatMap(ScratchAppService, (service) =>
        Effect.all([service.synthesizeId("My App"), service.synthesizeId("My App")]),
      );
      const [first, second] = await Effect.runPromise(program.pipe(Effect.provide(scratchAppLayer)));
      expect(first).toMatch(/^scratch-my-app-[0-9a-f]{6}$/u);
      expect(second).toMatch(/^scratch-my-app-[0-9a-f]{6}$/u);
      expect(first).not.toBe(second);
    });
  });

  test("paths lays out the scratch instance directories", async () => {
    await withTempCacheRoot(async (cacheRoot) => {
      const resolved = await Effect.runPromise(
        Effect.flatMap(ScratchAppService, (service) => service.paths("scratch-lamp-abc123")).pipe(
          Effect.provide(scratchAppLayer),
        ),
      );
      const base = join(cacheRoot, "scratch");
      const instanceRoot = join(base, "scratch-lamp-abc123");
      expect(resolved).toEqual({
        base,
        instanceRoot,
        root: join(instanceRoot, "root"),
        planCache: join(instanceRoot, "plan.bin"),
        infoCache: join(instanceRoot, "info.json"),
        buildResults: join(instanceRoot, "build-results.bin"),
      });
    });
  });

  test("paths rejects ids that would escape the scratch namespace", async () => {
    await withTempCacheRoot(async () => {
      for (const unsafe of ["..", ".", "../../etc", "a/b", "a\\b", ""]) {
        const result = await Effect.runPromise(
          Effect.flatMap(ScratchAppService, (service) => service.paths(unsafe)).pipe(
            Effect.provide(scratchAppLayer),
            Effect.either,
          ),
        );
        expect(result._tag).toBe("Left");
        if (result._tag === "Left") expect(result.left._tag).toBe("ScratchAppError");
      }
    });
  });

  test("the scratch bootstrap runtime tier provides ScratchAppService", async () => {
    await withTempCacheRoot(async (cacheRoot) => {
      const runtime = makeLandoRuntime({ bootstrap: "scratch" });
      const resolved = await Effect.runPromise(
        Effect.flatMap(ScratchAppService, (service) => service.root).pipe(Effect.provide(runtime)),
      );
      expect(resolved).toBe(join(cacheRoot, "scratch"));
    });
  });
});
