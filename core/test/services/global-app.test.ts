import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Layer } from "effect";

import { GlobalAppService } from "@lando/core/services";

import { GlobalAppServiceLive } from "../../src/global-app/service.ts";
import { ConfigServiceLive } from "../../src/services/config.ts";
import { FileSystemLive } from "../../src/services/file-system.ts";

const globalAppLayer = GlobalAppServiceLive.pipe(
  Layer.provide(Layer.mergeAll(ConfigServiceLive, FileSystemLive)),
);

const withTempRoots = async <T>(run: (dataRoot: string) => Promise<T>): Promise<T> => {
  const dataRoot = await mkdtemp(join(tmpdir(), "lando-global-app-data-"));
  const confRoot = await mkdtemp(join(tmpdir(), "lando-global-app-conf-"));
  const previousData = process.env.LANDO_USER_DATA_ROOT;
  const previousConf = process.env.LANDO_USER_CONF_ROOT;
  try {
    process.env.LANDO_USER_DATA_ROOT = dataRoot;
    process.env.LANDO_USER_CONF_ROOT = confRoot;
    return await run(dataRoot);
  } finally {
    // biome-ignore lint/performance/noDelete: process.env delete is required so Bun does not coerce undefined to the string "undefined".
    if (previousData === undefined) delete process.env.LANDO_USER_DATA_ROOT;
    else process.env.LANDO_USER_DATA_ROOT = previousData;
    // biome-ignore lint/performance/noDelete: process.env delete is required so Bun does not coerce undefined to the string "undefined".
    if (previousConf === undefined) delete process.env.LANDO_USER_CONF_ROOT;
    else process.env.LANDO_USER_CONF_ROOT = previousConf;
    await rm(dataRoot, { recursive: true, force: true });
    await rm(confRoot, { recursive: true, force: true });
  }
};

describe("GlobalAppServiceLive", () => {
  test("exposes the reserved global id", async () => {
    const id = await Effect.runPromise(
      Effect.map(GlobalAppService, (service) => service.id).pipe(Effect.provide(globalAppLayer)),
    );

    expect(id).toBe("global");
  });

  test("resolves the global app root under the user data root", async () => {
    await withTempRoots(async (dataRoot) => {
      const root = await Effect.runPromise(
        Effect.flatMap(GlobalAppService, (service) => service.root).pipe(Effect.provide(globalAppLayer)),
      );

      expect(root).toBe(join(dataRoot, "global"));
    });
  });

  test("ensureRoot creates the global app directory idempotently", async () => {
    await withTempRoots(async (dataRoot) => {
      const expectedRoot = join(dataRoot, "global");

      const ensure = Effect.scoped(Effect.flatMap(GlobalAppService, (service) => service.ensureRoot)).pipe(
        Effect.provide(globalAppLayer),
      );

      await Effect.runPromise(ensure);
      expect((await stat(expectedRoot)).isDirectory()).toBe(true);

      await Effect.runPromise(ensure);
      expect((await stat(expectedRoot)).isDirectory()).toBe(true);
    });
  });
});
