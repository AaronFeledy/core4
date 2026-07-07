import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";
import { Effect, Layer, Schema } from "effect";

import { CacheService, makeLandoRuntime, openLandoRuntime, resolveApp } from "@lando/core";
import { type LandofileShape, ProviderId, ServiceName } from "@lando/core/schema";
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

const landofileYaml = (name = "embedded-app", tooling = false): string =>
  `name: ${name}\nruntime: 4\nprovider: ${TestRuntimeProvider.id}\nservices:\n  web:\n    image: node:lts\n    primary: true\n${
    tooling ? "tooling:\n  build:\n    service: web\n    cmd: make build\n" : ""
  }`;

const appLayer = () =>
  makeLandoRuntime({
    bootstrap: "app",
    plugins: { policy: "bundled-only", layers: testProviderLayers },
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
          Effect.provide(appLayer()),
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
          Effect.provide(appLayer()),
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
          Effect.provide(appLayer()),
        ),
      );

      expect(result.app).toBe("embedded-app");
      expect(result.services.map((service) => service.service)).toContain(ServiceName.make("web"));
    });
  });

  test("handle methods stay bound to the captured root after the host cwd changes", async () => {
    await withTwoTempApps(async (left, right) => {
      const result = await Effect.runPromise(
        resolveApp()
          .pipe(
            Effect.flatMap((app) =>
              Effect.sync(() => process.chdir(right)).pipe(Effect.flatMap(() => app.info())),
            ),
            Effect.scoped,
            Effect.provide(appLayer()),
          )
          .pipe(Effect.ensuring(Effect.sync(() => process.chdir(left)))),
      );

      expect(result.app).toBe("embedded-app");
    });
  });

  test("a decoded Landofile selector resolves includes from its selected root", async () => {
    await withTempApp(async (dir) => {
      const service = ServiceName.make("web");
      await Bun.write(
        join(dir, "fragment.yml"),
        `services:\n  ${service}:\n    image: node:lts\n    primary: true\n`,
      );
      const landofile: LandofileShape = {
        name: "embedded-app",
        runtime: 4,
        provider: ProviderId.make(TestRuntimeProvider.id),
        includes: ["fragment.yml"],
      };

      const plan = await Effect.runPromise(
        resolveApp({ landofile, root: dir as never }).pipe(
          Effect.flatMap((app) => app.plan),
          Effect.scoped,
          Effect.provide(appLayer()),
        ),
      );

      expect(plan.id).toBe("embedded-app");
      expect(plan.services[service]?.name).toBe(service);
    });
  });

  test("a decoded Landofile selector enforces the lando version constraint", async () => {
    await withTempApp(async (dir) => {
      const error = await Effect.runPromise(
        Effect.flip(
          resolveApp({
            landofile: {
              name: "embedded-app",
              runtime: 4,
              provider: ProviderId.make(TestRuntimeProvider.id),
              lando: ">=99",
            },
            root: dir as never,
          }).pipe(Effect.scoped, Effect.provide(appLayer())),
        ),
      );

      expect(error._tag).toBe("AppResolveError");
      expect(error.message).toContain("LandofileVersionConstraintError");
      const causeTag =
        typeof error.cause === "object" && error.cause !== null && "_tag" in error.cause
          ? error.cause._tag
          : undefined;
      expect(causeTag).toBe("LandofileVersionConstraintError");
    });
  });

  test("a landofile path selector loads the explicit selected file", async () => {
    await withTempApp(async (dir) => {
      await Bun.write(join(dir, "custom.lando.yml"), landofileYaml("custom-app"));

      const app = await Effect.runPromise(
        resolveApp({ landofile: join(dir, "custom.lando.yml") as never }).pipe(
          Effect.scoped,
          Effect.provide(appLayer()),
        ),
      );

      expect(app.id).toBe("custom-app");
      expect(app.root).toBe(dir);
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

  test("runtime.app() with no selector resolves from the captured construction cwd", async () => {
    await withTempUserCache(async () => {
      await withTwoTempApps(async (left, right) => {
        const id = await Effect.runPromise(
          Effect.scoped(
            openLandoRuntime({ plugins: { policy: "bundled-only", layers: testProviderLayers } }).pipe(
              Effect.flatMap((runtime) =>
                Effect.sync(() => process.chdir(right)).pipe(
                  Effect.flatMap(() => runtime.app()),
                  Effect.flatMap((app) => app.info()),
                  Effect.map((info) => info.app),
                ),
              ),
            ),
          ).pipe(Effect.ensuring(Effect.sync(() => process.chdir(left)))),
        );

        expect(id).toBe("embedded-app");
      });
    });
  });

  test("resolveApp() with no selector resolves from the runtime layer cwd", async () => {
    await withTwoTempApps(async (left, right) => {
      const layer = makeLandoRuntime({
        bootstrap: "app",
        cwd: left,
        plugins: { policy: "bundled-only", layers: testProviderLayers },
      });
      const id = await Effect.runPromise(
        Effect.sync(() => process.chdir(right)).pipe(
          Effect.zipRight(resolveApp()),
          Effect.flatMap((app) => app.info()),
          Effect.map((info) => info.app),
          Effect.scoped,
          Effect.provide(layer),
        ),
      );

      expect(id).toBe("embedded-app");
    });
  });

  test("a runtime constructed with scratch resolves app() to the acquired scratch app", async () => {
    await withTempUserCache(async () => {
      await withTempApp(async () => {
        const id = await Effect.runPromise(
          Effect.scoped(
            openLandoRuntime({
              scratch: { source: { kind: "fork" }, detached: true, isolate: "none" },
              plugins: { policy: "bundled-only", layers: testProviderLayers },
            }).pipe(
              Effect.flatMap((runtime) => runtime.app()),
              Effect.map((app) => app.id),
            ),
          ),
        );

        expect(id).toStartWith("scratch-embedded-app-");
      });
    });
  });

  test("a runtime constructed with cwd and scratch acquires the scratch app from the captured cwd", async () => {
    await withTempUserCache(async () => {
      await withTwoTempApps(async (left, right) => {
        const id = await Effect.runPromise(
          Effect.scoped(
            openLandoRuntime({
              cwd: right,
              scratch: { source: { kind: "fork" }, detached: true, isolate: "none" },
              plugins: { policy: "bundled-only", layers: testProviderLayers },
            }).pipe(
              Effect.flatMap((runtime) => runtime.app()),
              Effect.map((app) => app.id),
            ),
          ).pipe(Effect.ensuring(Effect.sync(() => process.chdir(left)))),
        );

        expect(id).toStartWith("scratch-other-app-");
      });
    });
  });

  test("scratch default app tooling uses the captured target after host cwd changes", async () => {
    await withTempUserCache(async () => {
      const left = await realpath(await mkdtemp(join(tmpdir(), "lando-scratch-tooling-left-")));
      const right = await realpath(await mkdtemp(join(tmpdir(), "lando-scratch-tooling-right-")));
      const original = process.cwd();
      await Bun.write(join(left, ".lando.yml"), landofileYaml("embedded-app", true));
      await Bun.write(join(right, ".lando.yml"), landofileYaml("other-app"));
      process.chdir(left);
      try {
        const result = await Effect.runPromise(
          Effect.scoped(
            openLandoRuntime({
              scratch: { source: { kind: "fork" }, detached: true, isolate: "none" },
              plugins: { policy: "bundled-only", layers: testProviderLayers },
            }).pipe(
              Effect.flatMap((runtime) =>
                runtime
                  .app()
                  .pipe(
                    Effect.flatMap((app) =>
                      Effect.sync(() => process.chdir(right)).pipe(Effect.zipRight(app.tooling("build"))),
                    ),
                  ),
              ),
            ),
          ).pipe(Effect.ensuring(Effect.sync(() => process.chdir(left)))),
        );

        expect(result.tool).toBe("build");
        expect(result.service).toBe("web");
        expect(result.exitCode).toBe(0);
      } finally {
        process.chdir(original);
        await rm(left, { recursive: true, force: true });
        await rm(right, { recursive: true, force: true });
      }
    });
  });

  test("reusing one retained runtime shares bootstrap services across operations", async () => {
    await withTempUserCache(async () => {
      await withTempApp(async () => {
        const result = await Effect.runPromise(
          Effect.scoped(
            openLandoRuntime({ plugins: { policy: "bundled-only", layers: testProviderLayers } }).pipe(
              Effect.flatMap((runtime) =>
                Effect.gen(function* () {
                  yield* runtime.run(CacheService.pipe(Effect.flatMap((cache) => cache.write("k", "v"))));
                  return yield* runtime.run(
                    CacheService.pipe(Effect.flatMap((cache) => cache.read("k", Schema.String))),
                  );
                }),
              ),
            ),
          ),
        );

        expect(result).toBe("v");
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
          Effect.provide(appLayer()),
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
      resolveApp({ landofile: { name: "x" } } as never).pipe(Effect.scoped, Effect.provide(appLayer())),
    );
    expect(exit._tag).toBe("Failure");
  });

  test("a decoded Landofile selector rejects the reserved global app id", async () => {
    await withTempApp(async (dir) => {
      const exit = await Effect.runPromiseExit(
        resolveApp({ landofile: { name: "global" }, root: dir as never } as never).pipe(
          Effect.scoped,
          Effect.provide(appLayer()),
        ),
      );

      expect(exit._tag).toBe("Failure");
    });
  });

  test("an id selector validates a compatible cwd selector", async () => {
    await withTempApp(async (dir) => {
      const app = await Effect.runPromise(
        resolveApp({ id: "embedded-app", cwd: dir as never }).pipe(Effect.scoped, Effect.provide(appLayer())),
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
          Effect.provide(appLayer()),
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
          Effect.provide(appLayer()),
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
          Effect.provide(appLayer()),
        ),
      );

      expect(exit._tag).toBe("Failure");
    });
  });
});
