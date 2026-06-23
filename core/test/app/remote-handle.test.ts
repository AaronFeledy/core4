import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";
import { Effect, Layer } from "effect";

import { makeLandoRuntime, resolveApp } from "@lando/core";
import { ProviderId } from "@lando/core/schema";
import { RuntimeProvider, RuntimeProviderRegistry } from "@lando/core/services";
import { TestRuntimeProvider } from "@lando/core/testing";

const testProviderLayers = [
  Layer.succeed(RuntimeProvider, TestRuntimeProvider),
  Layer.succeed(RuntimeProviderRegistry, {
    list: Effect.succeed([ProviderId.make(TestRuntimeProvider.id)]),
    capabilities: Effect.succeed(TestRuntimeProvider.capabilities),
    select: () => Effect.succeed(TestRuntimeProvider),
  }),
];

const withTempApp = async <T>(run: (dir: string) => Promise<T>): Promise<T> => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "lando-remote-handle-")));
  await writeFile(
    join(dir, ".lando.yml"),
    `name: remote-handle\nruntime: 4\nprovider: ${TestRuntimeProvider.id}\nservices:\n  web:\n    type: node:lts\n`,
  );
  const original = process.cwd();
  process.chdir(dir);
  try {
    return await run(dir);
  } finally {
    process.chdir(original);
    await rm(dir, { recursive: true, force: true });
  }
};

describe("App remote-sync handle surface", () => {
  test("exposes pull, push, and the remote namespace", async () => {
    await withTempApp(async () => {
      const shape = await Effect.runPromise(
        resolveApp().pipe(
          Effect.map((app) => {
            const remote = (app as unknown as { readonly remote?: Record<string, unknown> }).remote;
            return {
              pull: typeof (app as unknown as { readonly pull?: unknown }).pull,
              push: typeof (app as unknown as { readonly push?: unknown }).push,
              remoteList: typeof remote?.list,
              remoteAdd: typeof remote?.add,
              remoteRemove: typeof remote?.remove,
              remoteTest: typeof remote?.test,
              remoteSetup: typeof remote?.setup,
              remoteEnvList: typeof (remote?.env as { readonly list?: unknown } | undefined)?.list,
            };
          }),
          Effect.scoped,
          Effect.provide(
            makeLandoRuntime({
              bootstrap: "app",
              plugins: { policy: "bundled-only", layers: testProviderLayers },
            }),
          ),
        ),
      );

      for (const value of Object.values(shape)) expect(value).toBe("function");
    });
  });
});
