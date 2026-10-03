import { expect, test } from "bun:test";
import * as PluginRegistryLayer from "@lando/engine/plugins/registry";
import { RuntimeLayerFactory } from "@lando/engine/runtime/runtime-layer-factory";
import * as BunFileSystem from "@lando/engine/services/file-system";
import { makeTestStateStore } from "@lando/engine/testing/state-store";
import { makeLandoPaths } from "@lando/paths";
import { ProviderId } from "@lando/sdk/schema";
import { FileSystem, PathsService, RuntimeProviderRegistry } from "@lando/sdk/services";
import { TestRuntimeProvider } from "@lando/sdk/test";
import { Effect, Layer, Schema } from "effect";
import { resilientDoctorReport } from "../../src/cli/commands/doctor-bootstrap";

test("safe-mode doctor inventories the state store supplied by its provider runtime", async () => {
  // Given a provider runtime with one isolated retained journal.
  const store = makeTestStateStore();
  const key = `${"b".repeat(64)}.json`;
  const bucket = await Effect.runPromise(
    store.service.open({
      root: "userData",
      namespace: "accelerated-starts",
      key,
      schema: Schema.Unknown,
      version: 1,
    }),
  );
  await Effect.runPromise(
    bucket.set({
      attemptId: "runtime-attempt",
      appId: "runtime-app",
      appRoot: "/apps/runtime",
      providerId: "test",
      engineId: "mutagen",
      mountPlanDigest: "digest",
      phase: "retained",
      sessions: [],
      targets: [],
    }),
  );
  const fsLayer = Layer.effect(
    FileSystem,
    Effect.map(FileSystem, (fs) => ({
      ...fs,
      readDir: () => Effect.succeed([key]),
    })),
  ).pipe(Layer.provide(BunFileSystem.layer));
  const runtime = Layer.mergeAll(
    store.layer,
    fsLayer,
    PluginRegistryLayer.layer,
    Layer.succeed(PathsService, makeLandoPaths({ env: {} })),
    Layer.succeed(RuntimeProviderRegistry, {
      list: Effect.succeed([ProviderId.make(TestRuntimeProvider.id)]),
      capabilities: Effect.succeed(TestRuntimeProvider.capabilities),
      select: () => Effect.succeed(TestRuntimeProvider),
    }),
  );
  // When the safe-mode entry point builds the runtime and collects its report.
  const report = await Effect.runPromise(
    resilientDoctorReport({ env: {} }).pipe(
      Effect.provideService(RuntimeLayerFactory, { make: () => runtime }),
    ),
  );
  // Then exactly the injected journal is reported, not journals from the ambient home.
  const checks = report.subsystems.checks.filter(({ name }) => name === "accelerated-start");
  expect(checks).toHaveLength(1);
  expect(checks[0]?.context).toMatchObject({
    appId: "runtime-app",
    attemptId: "runtime-attempt",
    journalPath: bucket.path,
  });
});
