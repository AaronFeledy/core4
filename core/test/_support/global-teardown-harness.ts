import { DateTime, Effect, Layer, Schema, Stream } from "effect";

import { makeLandoPaths } from "@lando/core/paths";
import { ProviderUnavailableError } from "@lando/sdk/errors";
import {
  AbsolutePath,
  AppId,
  type AppPlan,
  AppRef,
  ProviderId,
  ServiceName,
  type VolumeInfo,
  appIdentityKey,
} from "@lando/sdk/schema";
import {
  type DestroyOutcome,
  EventService,
  FileSystem,
  GlobalAppService,
  PathsService,
  RouterService,
  RuntimeProviderRegistry,
  type ServiceRuntimeInfo,
} from "@lando/sdk/services";
import { TestRuntimeProvider, makeTestRouterService } from "@lando/sdk/test";
import { PrivateFileAccessService } from "@lando/state-store/private-file-access";

import { join } from "node:path";
import * as BunFileSystem from "@lando/engine/services/file-system";

export const globalPlanAt = (root: AbsolutePath): AppPlan => ({
  id: AppId.make("global"),
  name: "global",
  slug: "global",
  root,
  identity: { appRoot: root, ownerKey: appIdentityKey("owner", root) },
  provider: ProviderId.make("lando"),
  services: {
    [ServiceName.make("ssh-agent")]: {
      name: ServiceName.make("ssh-agent"),
      type: "lando",
      provider: ProviderId.make("lando"),
      primary: true,
      artifact: { kind: "ref", ref: "ssh-agent:test" },
      environment: {},
      mounts: [],
      storage: [],
      endpoints: [],
      routes: [],
      dependsOn: [],
      hostAliases: [],
      metadata: {
        resolvedAt: DateTime.makeUnsafe("2026-10-01T00:00:00Z"),
        source: "applied-state",
        runtime: 4,
      },
      extensions: {},
    },
  },
  routes: [],
  networks: [],
  stores: [],
  fileSync: [],
  metadata: { resolvedAt: DateTime.makeUnsafe("2026-10-01T00:00:00Z"), source: "applied-state", runtime: 4 },
  extensions: {},
});

export const globalTeardownHarness = async (
  dataRoot: string,
  input: {
    readonly plan?: AppPlan;
    readonly orphanRoot?: AbsolutePath;
    readonly volumes?: ReadonlyArray<VolumeInfo>;
    readonly destroyOutcome?: DestroyOutcome;
    readonly availability?: Effect.Effect<boolean, ProviderUnavailableError>;
    readonly status?: Effect.Effect<{ readonly running: boolean }, ProviderUnavailableError>;
    readonly appliedPlans?: Effect.Effect<ReadonlyArray<AppPlan>, ProviderUnavailableError>;
    readonly services?: ReadonlyArray<ServiceRuntimeInfo>;
    readonly stopFailure?: boolean;
  } = {},
) => {
  const paths = makeLandoPaths({ userDataRoot: dataRoot, env: {}, platform: "linux" });
  const root = AbsolutePath.make(paths.globalAppRoot);
  const calls: string[] = [];
  const destroyed: AppPlan[] = [];
  const removed: ServiceRuntimeInfo[] = [];
  const eventRoots: string[] = [];
  const selectedRoots: string[] = [];
  const provider = {
    ...TestRuntimeProvider,
    id: "lando",
    appliedPlans: input.appliedPlans ?? Effect.succeed(input.plan === undefined ? [] : [input.plan]),
    isAvailable: input.availability ?? Effect.succeed(true),
    getStatus: input.status ?? Effect.succeed({ running: true }),
    ensureReady: Effect.sync(() => {
      calls.push("ensureReady");
    }),
    list: () =>
      Effect.sync(() => {
        calls.push("list");
        return (
          input.services ??
          (input.orphanRoot === undefined
            ? []
            : [
                {
                  app: AppId.make("global"),
                  appRoot: input.orphanRoot,
                  service: ServiceName.make("ssh-agent"),
                  providerId: ProviderId.make("lando"),
                  status: "running" as const,
                  containerId: "owned-container",
                },
              ])
        );
      }),
    listVolumes: () =>
      Effect.sync(() => {
        calls.push("listVolumes");
        return input.volumes ?? [];
      }),
    destroy: (target: { readonly plan?: AppPlan }) =>
      Effect.sync(() => {
        calls.push("destroy");
        if (target.plan !== undefined) destroyed.push(target.plan);
        return input.destroyOutcome ?? { kind: "destroyed" as const };
      }),
    removeObservedService: (service: ServiceRuntimeInfo) =>
      Effect.gen(function* () {
        calls.push("removeObservedService");
        if (input.stopFailure)
          return yield* Effect.fail(
            new ProviderUnavailableError({
              message: "remove failed",
              providerId: "lando",
              operation: "removeObservedService",
            }),
          );
        removed.push(service);
        return { kind: "removed" as const };
      }),
    removeVolume: () =>
      Effect.sync(() => {
        calls.push("removeVolume");
      }),
    stop: () => Effect.die("selected teardown must remove the observed container"),
  };
  const fileSystem = await Effect.runPromise(FileSystem.pipe(Effect.provide(BunFileSystem.layer)));
  const layer = Layer.mergeAll(
    PrivateFileAccessService.layer,
    Layer.succeed(PathsService, paths),
    Layer.succeed(FileSystem, { ...fileSystem, readText: () => Effect.die("desired YAML must not be read") }),
    Layer.succeed(
      GlobalAppService,
      GlobalAppService.of({
        id: "global",
        root: Effect.succeed(root),
        ensureRoot: Effect.die("root must not be materialized"),
        paths: Effect.succeed({
          root,
          distLandofile: AbsolutePath.make(join(root, ".lando.dist.yml")),
          userLandofile: AbsolutePath.make(join(root, ".lando.yml")),
        }),
        ensureUserLandofile: Effect.die("no authored config mutation"),
        ensureRunning: () => Effect.die("no startup"),
        regenerateDist: () => Effect.die("no materialization"),
      }),
    ),
    Layer.succeed(
      RuntimeProviderRegistry,
      RuntimeProviderRegistry.of({
        list: Effect.succeed([ProviderId.make("lando")]),
        capabilities: Effect.succeed(provider.capabilities),
        select: (target) => {
          if (target !== undefined && typeof target !== "string") selectedRoots.push(target.root);
          return Effect.succeed(provider);
        },
      }),
    ),
    Layer.succeed(
      RouterService,
      RouterService.of({
        ...makeTestRouterService(),
        removeRoutes: () =>
          Effect.sync(() => {
            calls.push("removeRoutes");
          }),
      }),
    ),
    Layer.succeed(
      EventService,
      EventService.of({
        publish: (event) =>
          Effect.sync(() => {
            calls.push(event._tag);
            if (event._tag === "pre-global-stop" || event._tag === "post-global-stop")
              eventRoots.push(Schema.decodeUnknownSync(AppRef)(event.app).root);
          }),
        subscribe: () => Stream.die("unused subscription"),
        subscribeQueue: Effect.die("unused queue"),
        waitFor: () => Effect.never,
        waitForAny: () => Effect.never,
        query: () => Effect.succeed([]),
      }),
    ),
  );
  return { layer, calls, destroyed, removed, eventRoots, selectedRoots };
};
