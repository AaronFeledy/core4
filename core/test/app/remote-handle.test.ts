import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";
import { Effect, Layer, Redacted } from "effect";

import { makeLandoRuntime, resolveApp } from "@lando/core";
import { ProviderId } from "@lando/core/schema";
import {
  Dataset,
  InteractionService,
  RemoteSource,
  RuntimeProvider,
  RuntimeProviderRegistry,
} from "@lando/core/services";
import { TestDataset, TestRemoteSource, TestRuntimeProvider } from "@lando/core/testing";

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

  test("pull composes confirmation through the runtime InteractionService", async () => {
    await withTempApp(async (dir) => {
      await writeFile(
        join(dir, ".lando.yml"),
        `name: remote-handle\nruntime: 4\nprovider: ${TestRuntimeProvider.id}\nservices:\n  web:\n    type: node:lts\nremotes:\n  test:\n    source: test\n`,
      );
      let confirms = 0;
      const interaction = {
        id: "remote-handle-interaction",
        isInteractive: Effect.succeed(true),
        prompt: () => Effect.die("prompt must not run"),
        promptAll: () => Effect.die("promptAll must not run"),
        confirm: () =>
          Effect.sync(() => {
            confirms += 1;
            return true;
          }),
        select: () => Effect.die("select must not run"),
        secret: () => Effect.succeed(Redacted.make("secret")),
      };

      const runtime = Layer.merge(
        makeLandoRuntime({
          bootstrap: "app",
          plugins: {
            policy: "bundled-only",
            layers: [
              ...testProviderLayers,
              Layer.succeed(RemoteSource, TestRemoteSource.source),
              Layer.succeed(Dataset, TestDataset.dataset),
            ],
          },
        }),
        Layer.succeed(InteractionService, interaction),
      );
      const result = await Effect.runPromise(
        resolveApp().pipe(
          Effect.flatMap((app) =>
            app.pull({
              remote: "test",
              env: TestRemoteSource.supportedEnv,
              only: [TestDataset.dataset.kind],
              noSnapshot: true,
            }),
          ),
          Effect.scoped,
          Effect.provide(runtime),
        ),
      );

      expect(result.direction).toBe("pull");
      expect(confirms).toBe(1);
    });
  });
});
