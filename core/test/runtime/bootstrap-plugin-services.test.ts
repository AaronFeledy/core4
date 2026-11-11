import { describe, expect, test } from "bun:test";
import { FileSyncResolver } from "@lando/engine/plugins/file-sync-resolver";
import { HostMaintenanceRegistry } from "@lando/engine/runtime/host-maintenance";
import { ServiceNotReadyError } from "@lando/sdk/errors";
import { AbsolutePath, AppId, ProviderId, ServiceName } from "@lando/sdk/schema";
import { FileSyncEngine, ServiceReadiness } from "@lando/sdk/services";
import { TestRuntimeProvider } from "@lando/sdk/test";
import { Context, DateTime, Effect, Layer, Option } from "effect";
import { makeLandoRuntime } from "../../src/runtime/layer.ts";

describe("bootstrap plugin services", () => {
  test("app bootstrap provides planned readiness that rejects an absent service", async () => {
    const failure = await Effect.runPromise(
      Effect.flatMap(ServiceReadiness, (readiness) =>
        readiness.wait({
          provider: TestRuntimeProvider,
          plan: {
            valueModel: 1,
            id: AppId.make("readiness-port"),
            name: "readiness-port",
            slug: "readiness-port",
            root: AbsolutePath.make("/readiness-port"),
            provider: ProviderId.make("test"),
            services: {},
            routes: [],
            stores: [],
            fileSync: [],
            extensions: {},
            metadata: { resolvedAt: DateTime.makeUnsafe(0), source: "readiness-test", runtime: 4 },
          },
          services: [ServiceName.make("absent")],
        }),
      ).pipe(
        Effect.flip,
        Effect.provide(makeLandoRuntime({ bootstrap: "app", plugins: { policy: "bundled-only" } })),
      ),
    );
    expect(failure).toBeInstanceOf(ServiceNotReadyError);
    expect(failure).toMatchObject({ service: "absent", reason: "inspect-failed" });
  });

  test("app bootstrap provides file-sync resolver without an eager engine", async () => {
    // Given: the real app bootstrap layer with bundled plugin descriptors.
    const context = await Effect.runPromise(
      Effect.scoped(Layer.build(makeLandoRuntime({ bootstrap: "app", plugins: { policy: "bundled-only" } }))),
    );

    // When: resolver and engine tags are resolved from the built context.
    const fileSyncResolver = Context.getOption(context, FileSyncResolver);
    const fileSyncEngine = Context.getOption(context, FileSyncEngine);

    // Then: selection is lazy through the resolver; no eager FileSyncEngine layer.
    expect(Option.isSome(fileSyncResolver)).toBe(true);
    expect(Option.isNone(fileSyncEngine)).toBe(true);
    if (Option.isSome(fileSyncResolver)) {
      expect(fileSyncResolver.value.candidates.map(({ id }) => id)).toContain("mutagen");
      const selected = await Effect.runPromise(
        fileSyncResolver.value.select({
          platform: "win32",
          bindMountPerformance: "slow",
          fileSyncTargets: "prepared-volume",
        }),
      );
      expect(selected?.id).toBe("mutagen");
      const native = await Effect.runPromise(
        fileSyncResolver.value.select({
          platform: "linux",
          bindMountPerformance: "native",
        }),
      );
      expect(native).toBeUndefined();
      const passthrough = await Effect.runPromise(
        fileSyncResolver.value.select({
          platform: "linux",
          bindMountPerformance: "slow",
          defaultEngine: "passthrough",
        }),
      );
      expect(passthrough).toBeUndefined();
    }
  });

  test("minimal bootstrap exposes bundled host maintenance to teardown commands", async () => {
    // Given: the real minimal runtime used by apps:poweroff and meta:uninstall.
    const context = await Effect.runPromise(
      Effect.scoped(Layer.build(makeLandoRuntime({ bootstrap: "minimal" }))),
    );

    // When: the optional host-maintenance service is resolved.
    const registry = Context.getOption(context, HostMaintenanceRegistry);

    // Then: minimal-bootstrap commands receive the bundled maintainer registry.
    expect(Option.isSome(registry)).toBe(true);
    if (Option.isSome(registry)) {
      expect(registry.value.maintainers.map((maintainer) => maintainer.id)).toContain(
        "lando-runtime-service",
      );
    }
  });
});
