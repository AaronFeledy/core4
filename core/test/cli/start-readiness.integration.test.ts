import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openLandoRuntime } from "@lando/core";
import { makePluginStateStore } from "@lando/engine/plugins/context-state";
import { resolveLiveProviderSocket } from "@lando/engine/testing/live-provider-socket";
import { makeTestStateStore } from "@lando/engine/testing/state-store";
import { makeRuntimeProvider } from "@lando/provider-podman";
import { ServiceNotReadyError } from "@lando/sdk/errors";
import { AbsolutePath, AppId, PortablePath, ProviderId, ServiceName } from "@lando/sdk/schema";
import { RouterService, RuntimeProviderRegistry } from "@lando/sdk/services";
import { TestRouterService } from "@lando/sdk/test";
import { Effect, Layer, Result } from "effect";

const socket = resolveLiveProviderSocket();

test.skipIf(socket === undefined)(
  "fresh PostgreSQL 18 answers a query immediately after start returns",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "lando-start-pg18-"));
    try {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            if (socket === undefined) return yield* Effect.die("Expected live socket");
            const name = `readiness-pg-${crypto.randomUUID().slice(0, 8)}`;
            const provider = yield* makeRuntimeProvider({
              platform: "linux",
              socketPath: socket.socketPath,
              appliedPlanState: makePluginStateStore(makeTestStateStore().service, AbsolutePath.make(root), {
                enforce: async () => undefined,
                verify: async () => undefined,
              }),
            });
            const runtime = yield* openLandoRuntime({
              cwd: root,
              config: {
                userDataRoot: AbsolutePath.make(join(root, "data")),
                userCacheRoot: AbsolutePath.make(join(root, "cache")),
                userConfRoot: AbsolutePath.make(join(root, "conf")),
              },
              plugins: {
                policy: "bundled-only",
                layers: [
                  Layer.succeed(
                    RuntimeProviderRegistry,
                    RuntimeProviderRegistry.of({
                      list: Effect.succeed([ProviderId.make(provider.id)]),
                      capabilities: Effect.succeed(provider.capabilities),
                      select: () => Effect.succeed(provider),
                    }),
                  ),
                  Layer.succeed(RouterService, TestRouterService),
                ],
              },
            });
            const app = yield* runtime.app({
              root: AbsolutePath.make(root),
              landofile: {
                name,
                runtime: 4,
                provider: ProviderId.make(provider.id),
                router: { enabled: false },
                services: {
                  [ServiceName.make("db")]: { type: "postgres:18", appMount: false, home: false, routes: [] },
                },
              },
            });
            yield* Effect.addFinalizer(() => runtime.run(app.destroy({ volumes: true })).pipe(Effect.orDie));
            yield* app.start();
            const result = yield* provider.exec(
              { app: AppId.make(name), service: ServiceName.make("db") },
              {
                command: [
                  "sh",
                  "-c",
                  'psql -h 127.0.0.1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -tAc "SELECT 18"',
                ],
              },
            );
            expect(result.exitCode).toBe(0);
            expect(result.stdout.trim()).toBe("18");
          }),
        ),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
  240_000,
);

test.skipIf(socket === undefined)(
  "Apache runtime startup failure retains the container and reports exit code and logs",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "lando-start-apache-"));
    try {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            if (socket === undefined) return yield* Effect.die("Expected live socket");
            const name = `readiness-apache-${crypto.randomUUID().slice(0, 8)}`;
            const provider = yield* makeRuntimeProvider({
              platform: "linux",
              socketPath: socket.socketPath,
              appliedPlanState: makePluginStateStore(makeTestStateStore().service, AbsolutePath.make(root), {
                enforce: async () => undefined,
                verify: async () => undefined,
              }),
            });
            const runtime = yield* openLandoRuntime({
              cwd: root,
              config: {
                userDataRoot: AbsolutePath.make(join(root, "data")),
                userCacheRoot: AbsolutePath.make(join(root, "cache")),
                userConfRoot: AbsolutePath.make(join(root, "conf")),
              },
              plugins: {
                policy: "bundled-only",
                layers: [
                  Layer.succeed(
                    RuntimeProviderRegistry,
                    RuntimeProviderRegistry.of({
                      list: Effect.succeed([ProviderId.make(provider.id)]),
                      capabilities: Effect.succeed(provider.capabilities),
                      select: () => Effect.succeed(provider),
                    }),
                  ),
                  Layer.succeed(RouterService, TestRouterService),
                ],
              },
            });
            const app = yield* runtime.app({
              root: AbsolutePath.make(root),
              landofile: {
                name,
                runtime: 4,
                provider: ProviderId.make(provider.id),
                router: { enabled: false },
                services: {
                  [ServiceName.make("web")]: {
                    type: "apache",
                    appMount: false,
                    webroot: PortablePath.make("/srv/missing"),
                    home: false,
                    routes: [],
                  },
                },
              },
            });
            yield* Effect.addFinalizer(() => runtime.run(app.destroy({ volumes: true })).pipe(Effect.orDie));
            const result = yield* Effect.result(app.start());
            expect(Result.isFailure(result)).toBe(true);
            if (!Result.isFailure(result) || !(result.failure instanceof ServiceNotReadyError))
              return yield* Effect.die("Expected post-apply ServiceNotReadyError");
            expect(result.failure.exitCode).toBeGreaterThan(0);
            expect(result.failure.logTail?.lines.join("\n")).toContain("AH00526");
            const observed = yield* provider.inspect({
              app: AppId.make(name),
              service: ServiceName.make("web"),
            });
            expect(observed.containerId).toBeDefined();
            expect(observed.exitCode).toBe(result.failure.exitCode);
          }),
        ),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
  240_000,
);
