import { expect } from "bun:test";
import { ProviderUnavailableError, type ScratchAppError } from "@lando/sdk/errors";
import { AbsolutePath, AppId, ProviderId, ServiceName } from "@lando/sdk/schema";
import { RuntimeProviderRegistry, type RuntimeProviderShape } from "@lando/sdk/services";
import { TestRuntimeProvider } from "@lando/sdk/test";
import { Effect } from "effect";
import { ScratchResourceScanner } from "../../src/scratch-app/scanner.ts";

export const scratchId = "scratch-demo-123456";
export const labels = { "dev.lando.scratch": "TRUE", "dev.lando.scratch-id": scratchId };
export const service = {
  app: AppId.make(scratchId),
  service: ServiceName.make("app"),
  providerId: ProviderId.make("other"),
  status: "running",
  containerId: "observed-container",
  labels,
};
export const volume = {
  ref: { app: AppId.make(scratchId), store: "data", scope: "app" as const },
  identity: {
    coordinationKey: "volume-key",
    nativeName: "scratch-volume",
    generation: "generation-1",
    ownerRoot: AbsolutePath.make("/tmp/scratch-demo"),
    origin: "created" as const,
  },
  labels,
};
export const unavailable = new ProviderUnavailableError({
  providerId: "other",
  operation: "test",
  message: "offline",
});

export const fixture = (overrides: Partial<RuntimeProviderShape> = {}) => {
  const id = overrides.id ?? "other";
  const services = [
    { ...service, providerId: ProviderId.make(id), containerId: `${id}-container-1` },
    { ...service, providerId: ProviderId.make(id), containerId: `${id}-container-2` },
  ];
  const observedVolume = {
    ...volume,
    ref: { ...volume.ref, store: `${id}-data` },
    identity: {
      ...volume.identity,
      nativeName: `${id}-data`,
      coordinationKey: JSON.stringify([`endpoint:${id}`, `${id}-data`]),
      generation: `${id}-generation`,
    },
  };
  const removedServices: unknown[] = [];
  const removedVolumes: unknown[] = [];
  const provider: RuntimeProviderShape = {
    ...TestRuntimeProvider,
    id,
    setup: () => Effect.die("scanner must not set up runtimes"),
    start: () => Effect.die("scanner must not start runtimes"),
    list: (filter) => {
      expect(filter).toEqual({ includeScratch: true, includeUnplanned: true });
      return Effect.succeed(services);
    },
    listVolumes: (filter) => {
      expect(filter).toEqual({ labels: { "dev.lando.scratch": "TRUE" } });
      return Effect.succeed([observedVolume]);
    },
    removeObservedService: (observed) =>
      Effect.sync(() => {
        removedServices.push(observed);
        return { kind: "removed" as const };
      }),
    removeVolume: (ref, generation) =>
      Effect.sync(() => {
        removedVolumes.push({ ref, generation });
      }),
    ...overrides,
  };
  return { provider, removedServices, removedVolumes, services, observedVolume };
};

export const runScanner = <A, E>(
  providers: readonly RuntimeProviderShape[],
  use: (scanner: typeof ScratchResourceScanner.Service) => Effect.Effect<A, E | ScratchAppError>,
) =>
  Effect.runPromise(
    Effect.flatMap(ScratchResourceScanner, use).pipe(
      Effect.provide(ScratchResourceScanner.layer),
      Effect.provideService(
        RuntimeProviderRegistry,
        RuntimeProviderRegistry.of({
          list: Effect.succeed(providers.map((provider) => ProviderId.make(provider.id))),
          capabilities: Effect.succeed(TestRuntimeProvider.capabilities),
          select: (target) => {
            const id = typeof target === "string" ? target : target?.provider;
            const provider =
              id === undefined ? providers[0] : providers.find((candidate) => candidate.id === id);
            return provider === undefined ? Effect.fail(unavailable) : Effect.succeed(provider);
          },
        }),
      ),
    ),
  );

export const emptyProvider = { ...TestRuntimeProvider, id: "default" };
