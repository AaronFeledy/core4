import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";
import { Effect, Layer } from "effect";

import { makeLandoRuntime, openLandoRuntime, resolveApp } from "@lando/core";
import { ProviderId, ServiceName } from "@lando/core/schema";
import { RuntimeProvider, RuntimeProviderRegistry } from "@lando/core/services";
import { TestRuntimeProvider } from "@lando/core/testing";

const landofileYaml = (name = "embedded-app"): string =>
  `name: ${name}\nruntime: 4\nprovider: ${TestRuntimeProvider.id}\nservices:\n  web:\n    image: node:lts\n    primary: true\n`;

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
  await Bun.write(join(dir, ".lando.yml"), landofileYaml());
  const original = process.cwd();
  process.chdir(dir);
  try {
    return await run(dir);
  } finally {
    process.chdir(original);
    await rm(dir, { recursive: true, force: true });
  }
};

const withTempUserCache = async <T>(run: (dir: string) => Promise<T>): Promise<T> => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "lando-runtime-cache-")));
  const original = process.env.LANDO_USER_CACHE_ROOT;
  process.env.LANDO_USER_CACHE_ROOT = dir;
  try {
    return await run(dir);
  } finally {
    if (original === undefined) process.env.LANDO_USER_CACHE_ROOT = undefined;
    else process.env.LANDO_USER_CACHE_ROOT = original;
    await rm(dir, { recursive: true, force: true });
  }
};

const withTwoTempApps = async <T>(run: (left: string, right: string) => Promise<T>): Promise<T> => {
  const left = await realpath(await mkdtemp(join(tmpdir(), "lando-resolve-app-left-")));
  const right = await realpath(await mkdtemp(join(tmpdir(), "lando-resolve-app-right-")));
  await Bun.write(join(left, ".lando.yml"), landofileYaml("embedded-app"));
  await Bun.write(join(right, ".lando.yml"), landofileYaml("other-app"));
  const original = process.cwd();
  process.chdir(left);
  try {
    return await run(left, right);
  } finally {
    process.chdir(original);
    await rm(left, { recursive: true, force: true });
    await rm(right, { recursive: true, force: true });
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

  test("openLandoRuntime exposes a working scratch API", async () => {
    await withTempUserCache(async () => {
      await withTempApp(async () => {
        const handle = await Effect.runPromise(
          Effect.scoped(
            openLandoRuntime({
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
            }).pipe(
              Effect.flatMap((runtime) =>
                runtime.scratch({ source: { kind: "fork" }, detached: true, isolate: "none" }),
              ),
            ),
          ),
        );

        expect(handle.id).toStartWith("scratch-embedded-app-");
        expect(handle.app.kind).toBe("scratch");
      });
    });
  });

  test("config lint defaults to the resolved app root and honors explicit cwd", async () => {
    await withTwoTempApps(async (left, right) => {
      const result = await Effect.runPromise(
        resolveApp({ root: right as never }).pipe(
          Effect.flatMap((app) =>
            Effect.all({
              defaultLint: app.config.lint(),
              explicitLint: app.config.lint({ cwd: left }),
            }),
          ),
          Effect.scoped,
          Effect.provide(appLayer),
        ),
      );

      expect(result.defaultLint.app).toBe("other-app");
      expect(result.defaultLint.file).toBe(join(right, ".lando.yml"));
      expect(result.explicitLint.app).toBe("embedded-app");
      expect(result.explicitLint.file).toBe(join(left, ".lando.yml"));
    });
  });

  test("a decoded Landofile selector without a root fails with AppResolveError(missing-root)", async () => {
    const exit = await Effect.runPromiseExit(
      resolveApp({ landofile: { name: "x" } } as never).pipe(Effect.scoped, Effect.provide(appLayer)),
    );
    expect(exit._tag).toBe("Failure");
  });

  test("a decoded Landofile selector rejects the reserved global app id", async () => {
    await withTempApp(async (dir) => {
      const exit = await Effect.runPromiseExit(
        resolveApp({ landofile: { name: "global" }, root: dir as never } as never).pipe(
          Effect.scoped,
          Effect.provide(appLayer),
        ),
      );

      expect(exit._tag).toBe("Failure");
    });
  });

  test("an id selector validates a compatible cwd selector", async () => {
    await withTempApp(async (dir) => {
      const app = await Effect.runPromise(
        resolveApp({ id: "embedded-app", cwd: dir as never }).pipe(Effect.scoped, Effect.provide(appLayer)),
      );

      expect(app.id).toBe("embedded-app");
      expect(app.root).toBe(dir);
    });
  });

  test("an id selector fails when cwd resolves to a different app", async () => {
    await withTwoTempApps(async (left, right) => {
      const exit = await Effect.runPromiseExit(
        resolveApp({ id: "embedded-app", root: left as never, cwd: right as never }).pipe(
          Effect.scoped,
          Effect.provide(appLayer),
        ),
      );

      expect(exit._tag).toBe("Failure");
    });
  });

  test("a root selector fails when cwd resolves to a different app", async () => {
    await withTwoTempApps(async (left, right) => {
      const exit = await Effect.runPromiseExit(
        resolveApp({ root: left as never, cwd: right as never }).pipe(
          Effect.scoped,
          Effect.provide(appLayer),
        ),
      );

      expect(exit._tag).toBe("Failure");
    });
  });

  test("a landofile path selector fails when root resolves to a different app", async () => {
    await withTwoTempApps(async (left, right) => {
      const exit = await Effect.runPromiseExit(
        resolveApp({ landofile: join(left, ".lando.yml") as never, root: right as never }).pipe(
          Effect.scoped,
          Effect.provide(appLayer),
        ),
      );

      expect(exit._tag).toBe("Failure");
    });
  });
});
