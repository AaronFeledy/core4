import { expect, test } from "bun:test";
import { PluginRegistryLive } from "@lando/engine/plugins/registry";
import { RuntimeLayerFactory } from "@lando/engine/runtime/runtime-layer-factory";
import { FileSystemLive } from "@lando/engine/services/file-system";
import { makeLandoPaths } from "@lando/paths";
import { AbsolutePath, AppId, ProviderId, ServiceName } from "@lando/sdk/schema";
import { FileSystem, PathsService, RuntimeProviderRegistry } from "@lando/sdk/services";
import { TestRuntimeProvider } from "@lando/sdk/test";
import { Effect, Layer } from "effect";
import { resilientDoctorReport } from "../../src/cli/commands/doctor-bootstrap";

test.each([false, true])(
  "safe-mode doctor reports missing roots without automatic teardown, fix=%s",
  async (fix) => {
    let mutations = 0;
    const provider = {
      ...TestRuntimeProvider,
      destroy: () =>
        Effect.sync(() => {
          mutations += 1;
          return { kind: "destroyed" as const };
        }),
      removeVolume: () =>
        Effect.sync(() => {
          mutations += 1;
        }),
    };
    const runtime = Layer.mergeAll(
      PluginRegistryLive,
      Layer.succeed(PathsService, makeLandoPaths({ env: {} })),
      Layer.effect(
        FileSystem,
        Effect.map(FileSystem, (fs) => ({ ...fs, exists: () => Effect.succeed(false) })),
      ).pipe(Layer.provide(FileSystemLive)),
      Layer.succeed(RuntimeProviderRegistry, {
        list: Effect.succeed([ProviderId.make(provider.id)]),
        capabilities: Effect.succeed(provider.capabilities),
        select: () => Effect.succeed(provider),
        observeRuntime: Effect.succeed([
          {
            providerId: ProviderId.make(provider.id),
            runtimeObserved: true,
            appliedPlans: [],
            volumes: [],
            services: [
              {
                app: AppId.make("gone"),
                appRoot: AbsolutePath.make("/apps/gone"),
                service: ServiceName.make("web"),
                providerId: ProviderId.make(provider.id),
                status: "running",
                containerId: "observed-container",
              },
            ],
          },
        ]),
      }),
    );
    const report = await Effect.runPromise(
      resilientDoctorReport({ env: {}, fix }).pipe(
        Effect.provideService(RuntimeLayerFactory, { make: () => runtime }),
      ),
    );
    const checks = report.subsystems.checks.filter(({ name }) => name === "missing-app-root");
    expect(checks).toHaveLength(1);
    expect(checks[0]).toMatchObject({
      context: { appRoot: "/apps/gone" },
      status: "warn",
      recovery: "manual",
      solutions: [{ kind: "manual", command: "lando destroy --root /apps/gone --volumes" }],
    });
    expect(mutations).toBe(0);
  },
);
