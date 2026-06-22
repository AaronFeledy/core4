import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";
import { Effect, Layer } from "effect";

import { makeLandoRuntime, resolveApp } from "@lando/core";
import { ProviderId, ServiceName } from "@lando/core/schema";
import { RuntimeProvider, RuntimeProviderRegistry } from "@lando/core/services";
import { TestRuntimeProvider } from "@lando/core/testing";

const landofileYaml = `name: embedded-app\nruntime: 4\nprovider: ${TestRuntimeProvider.id}\nservices:\n  web:\n    image: node:lts\n    primary: true\n`;

const appLayer = makeLandoRuntime({
  bootstrap: "app",
  plugins: {
    policy: "bundled-only",
    layers: [
      Layer.succeed(RuntimeProvider, TestRuntimeProvider),
      Layer.succeed(RuntimeProviderRegistry, {
        list: Effect.succeed([ProviderId.make(TestRuntimeProvider.id)]),
        capabilities: Effect.succeed(TestRuntimeProvider.capabilities),
        select: () => Effect.succeed(TestRuntimeProvider),
      }),
    ],
  },
});

const withTempApp = async <T>(run: (dir: string) => Promise<T>): Promise<T> => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "lando-resolve-app-")));
  await Bun.write(join(dir, ".lando.yml"), landofileYaml);
  const original = process.cwd();
  process.chdir(dir);
  try {
    return await run(dir);
  } finally {
    process.chdir(original);
    await rm(dir, { recursive: true, force: true });
  }
};

describe("resolveApp", () => {
  test("resolves from cwd and returns a branded handle with id, ref, root, and plan", async () => {
    await withTempApp(async (dir) => {
      const result = await Effect.runPromise(
        resolveApp().pipe(
          Effect.flatMap((app) =>
            app.plan.pipe(Effect.map((plan) => ({ id: app.id, ref: app.ref, root: app.root, plan }))),
          ),
          Effect.scoped,
          Effect.provide(appLayer),
        ),
      );

      expect(result.id).toBe("embedded-app");
      expect(result.ref.kind).toBe("user");
      expect(result.ref.id).toBe("embedded-app");
      expect(result.root).toBe(dir);
      expect(result.plan.id).toBe("embedded-app");
    });
  });

  test("exposes every published handle method", async () => {
    await withTempApp(async () => {
      const shape = await Effect.runPromise(
        resolveApp().pipe(
          Effect.map((app) => ({
            start: typeof app.start,
            stop: typeof app.stop,
            restart: typeof app.restart,
            rebuild: typeof app.rebuild,
            destroy: typeof app.destroy,
            info: typeof app.info,
            exec: typeof app.exec,
            tooling: typeof app.tooling,
            logs: typeof app.logs,
            configLint: typeof app.config.lint,
            eventsSubscribe: typeof app.events.subscribe,
          })),
          Effect.scoped,
          Effect.provide(appLayer),
        ),
      );

      for (const value of Object.values(shape)) expect(value).toBe("function");
    });
  });

  test("a method delegates to the underlying operation through the captured runtime", async () => {
    await withTempApp(async () => {
      const result = await Effect.runPromise(
        resolveApp().pipe(
          Effect.flatMap((app) => app.info()),
          Effect.scoped,
          Effect.provide(appLayer),
        ),
      );

      expect(result.app).toBe("embedded-app");
      expect(result.services.map((service) => service.service)).toContain(ServiceName.make("web"));
    });
  });

  test("a decoded Landofile selector without a root fails with AppResolveError(missing-root)", async () => {
    const exit = await Effect.runPromiseExit(
      resolveApp({ landofile: { name: "x" } } as never).pipe(Effect.scoped, Effect.provide(appLayer)),
    );
    expect(exit._tag).toBe("Failure");
  });
});
