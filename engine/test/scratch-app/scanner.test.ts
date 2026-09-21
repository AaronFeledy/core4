import { describe, expect, test } from "bun:test";

import { Effect, Layer } from "effect";

import type { ScratchAppError } from "@lando/sdk/errors";
import { AbsolutePath, AppId, ProviderId, ServiceName } from "@lando/sdk/schema";
import { RuntimeProviderRegistry, type RuntimeProviderShape } from "@lando/sdk/services";
import { TestRuntimeProvider } from "@lando/sdk/test";

import { ScratchResourceScanner, ScratchResourceScannerLive } from "../../src/scratch-app/scanner.ts";

const scratchId = "scratch-demo-123456";
const providerId = ProviderId.make("test");

const scratchService = {
  app: AppId.make(scratchId),
  service: ServiceName.make("app"),
  providerId,
  status: "running",
  containerId: "container-1",
  labels: {
    "dev.lando.scratch": "TRUE",
    "dev.lando.scratch-id": scratchId,
  },
};

const runScanner = <A>(
  use: (scanner: typeof ScratchResourceScanner.Service) => Effect.Effect<A, ScratchAppError>,
) =>
  Effect.runPromise(
    Effect.flatMap(ScratchResourceScanner, use).pipe(
      Effect.provide(ScratchResourceScannerLive),
      Effect.provide(
        Layer.succeed(RuntimeProviderRegistry, {
          list: Effect.succeed([providerId]),
          capabilities: Effect.succeed(TestRuntimeProvider.capabilities),
          select: () => Effect.succeed(provider),
        }),
      ),
    ),
  );

const removedServices: string[] = [];
const removedVolumes: string[] = [];
const provider: RuntimeProviderShape = {
  ...TestRuntimeProvider,
  id: String(providerId),
  list: () =>
    Effect.succeed([
      scratchService,
      { ...scratchService, containerId: "container-2" },
      {
        ...scratchService,
        app: AppId.make("ordinary-app"),
        containerId: "container-3",
        labels: { "dev.lando.app": "ordinary-app" },
      },
      {
        ...scratchService,
        app: AppId.make("ordinary-app"),
        containerId: "container-4",
        labels: {
          "dev.lando.scratch": "TRUE",
          "dev.lando.scratch-id": "registry.bin",
        },
      },
    ]),
  listVolumes: () =>
    Effect.succeed([
      {
        ref: { app: AppId.make(scratchId), store: "data", scope: "app" },
        identity: {
          coordinationKey: "volume-key",
          nativeName: "scratch-volume",
          generation: "generation-1",
          ownerRoot: AbsolutePath.make("/tmp/scratch-demo"),
          origin: "created",
        },
        labels: {
          "dev.lando.scratch": "TRUE",
          "dev.lando.scratch-id": scratchId,
        },
      },
    ]),
  removeObservedService: (service) =>
    Effect.sync(() => {
      removedServices.push(service.containerId ?? "missing");
      return { kind: "removed" as const };
    }),
  removeVolume: (ref) => Effect.sync(() => removedVolumes.push(ref.store)),
};

describe("ScratchResourceScannerLive", () => {
  test("lists unique scratch ids from provider labels", async () => {
    expect(await runScanner((scanner) => scanner.listScratchIds)).toEqual([scratchId]);
  });

  test("ignores spoofed noncanonical scratch ids", async () => {
    removedServices.length = 0;
    expect(await runScanner((scanner) => scanner.listScratchIds)).toEqual([scratchId]);
    await runScanner((scanner) => scanner.pruneScratch("registry.bin"));
    expect(removedServices).toEqual([]);
  });

  test("prunes labeled services and volumes idempotently", async () => {
    removedServices.length = 0;
    removedVolumes.length = 0;

    await runScanner((scanner) => scanner.pruneScratch(scratchId));
    await runScanner((scanner) => scanner.pruneScratch(scratchId));

    expect(removedServices).toEqual(["container-1", "container-2", "container-1", "container-2"]);
    expect(removedVolumes).toEqual(["data", "data"]);
  });
});
