import { DateTime, Effect, Layer, Schema, Stream } from "effect";

import { makeLandoPaths } from "@lando/paths";
import { ProviderUnavailableError, ProxyError } from "@lando/sdk/errors";
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
import type { LandoEvent } from "@lando/sdk/services";
import {
  type DestroyOptions,
  type DestroyOutcome,
  EventService,
  FileSystem,
  GlobalAppService,
  PathsService,
  PluginRegistry,
  RouterService,
  RuntimeProviderRegistry,
  type ServiceRuntimeInfo,
  StateStore,
} from "@lando/sdk/services";
import { TestRuntimeProvider, makeTestRouterService } from "@lando/sdk/test";
import { PrivateFileAccessService } from "@lando/state-store/private-file-access";

import { join } from "node:path";
import * as BunFileSystem from "@lando/engine/services/file-system";
import { makeStateStore } from "@lando/state-store/service";
import { CertificateAuthorityResolver } from "../plugins/certificate-authority-resolver.ts";
import { RouterServiceRegistry } from "../subsystems/proxy/registry.ts";

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
    readonly routeFailure?: boolean;
  } = {},
) => {
  const paths = makeLandoPaths({
    userDataRoot: dataRoot,
    userCacheRoot: join(dataRoot, "cache"),
    userConfRoot: join(dataRoot, "conf"),
    systemPluginRoot: join(dataRoot, "sys"),
    env: {},
    platform: "linux",
  });
  const root = AbsolutePath.make(paths.globalAppRoot);
  const calls: string[] = [];
  const events: LandoEvent[] = [];
  const destroyOptions: DestroyOptions[] = [];
  const destroyed: AppPlan[] = [];
  const removed: ServiceRuntimeInfo[] = [];
  const eventRoots: string[] = [];
  const selectedRoots: string[] = [];
  const routeRoots: string[] = [];
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
        if (input.services !== undefined) return input.services;
        if (input.orphanRoot === undefined) return [];
        return [
          {
            app: AppId.make("global"),
            appRoot: input.orphanRoot,
            service: ServiceName.make("ssh-agent"),
            providerId: ProviderId.make("lando"),
            status: "running" as const,
            containerId: "owned-container",
            publications: { status: "unknown" as const },
          },
        ];
      }),
    listVolumes: () =>
      Effect.sync(() => {
        calls.push("listVolumes");
        return input.volumes ?? [];
      }),
    destroy: (target: { readonly plan?: AppPlan }, options: DestroyOptions) =>
      Effect.sync(() => {
        calls.push("destroy");
        destroyOptions.push(options);
        if (target.plan !== undefined) destroyed.push(target.plan);
        return input.destroyOutcome ?? { kind: "destroyed" as const };
      }),
    removeObservedService: Effect.fnUntraced(function* (service: ServiceRuntimeInfo) {
      calls.push("removeObservedService");
      if (input.stopFailure)
        return yield* Effect.fail(
          new ProviderUnavailableError({
            message: "remove failed",
            providerId: "lando",
            operation: "removeObservedService",
            remediation: "Remove failed",
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
  const router = RouterService.of({
    ...makeTestRouterService(),
    removeRoutes: Effect.fnUntraced(function* (_app: AppId) {
      calls.push("removeRoutes");
      if (input.routeFailure)
        return yield* Effect.fail(
          new ProxyError({
            proxyId: "test",
            message: "route removal failed",
            remediation: "Repair the test router and retry.",
          }),
        );
    }),
  });
  const routerLayer = Layer.effect(
    RouterService,
    Effect.gen(function* () {
      const capturedRoot = (yield* (yield* GlobalAppService).paths.pipe(
        Effect.mapError(
          (cause) =>
            new ProxyError({
              proxyId: router.id,
              message: cause.message,
              remediation: cause.remediation,
              cause,
            }),
        ),
      )).root;
      return RouterService.of({
        ...router,
        removeRoutes: (app) => {
          routeRoots.push(capturedRoot);
          return router.removeRoutes(app);
        },
      });
    }),
  );
  const layer = Layer.mergeAll(
    Layer.succeed(CertificateAuthorityResolver, {
      resolve: Effect.die("No certificate issuance during teardown"),
    }),
    Layer.succeed(RouterServiceRegistry, {
      list: Effect.succeed([router.id]),
      select: () => Effect.succeed({ id: router.id, layer: routerLayer }),
    }),
    Layer.succeed(
      StateStore,
      makeStateStore({
        privateFileAccess: { enforce: async () => undefined, verify: async () => undefined },
      }),
    ),
    Layer.succeed(
      PluginRegistry,
      PluginRegistry.of({
        list: Effect.succeed([]),
        load: () => Effect.die("no plugin load during teardown"),
        loadServiceType: () => Effect.die("no service type load during teardown"),
        loadServiceFeature: () => Effect.die("no service feature load during teardown"),
        loadAppFeature: () => Effect.die("no app feature load during teardown"),
      }),
    ),
    PrivateFileAccessService.layer,
    Layer.succeed(PathsService, paths),
    Layer.succeed(FileSystem, { ...fileSystem, readText: () => Effect.die("desired YAML must not be read") }),
    Layer.succeed(
      GlobalAppService,
      GlobalAppService.of({
        id: "global",
        providerId: Effect.succeed(ProviderId.make("lando")),
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
        resolveAppliedPlan: () => Effect.succeed(undefined),
        resolveTeardownEvidence: () => Effect.succeed({ kind: "absent" as const }),
        appliedPlansFor: () => provider.appliedPlans,
        list: Effect.succeed([ProviderId.make("lando")]),
        capabilities: Effect.succeed(provider.capabilities),
        select: (target) => {
          if (target !== undefined && typeof target !== "string") selectedRoots.push(target.root);
          return Effect.succeed(provider);
        },
      }),
    ),
    Layer.succeed(RouterService, {
      ...router,
      removeRoutes: (app) => {
        routeRoots.push(root);
        return router.removeRoutes(app);
      },
    }),
    Layer.succeed(
      EventService,
      EventService.of({
        publish: (event) =>
          Effect.sync(() => {
            calls.push(event._tag);
            events.push(event);
            if (event._tag === "pre-global-stop" || event._tag === "post-global-stop")
              eventRoots.push(Schema.decodeUnknownSync(AppRef)(event.app).root);
          }),
        subscribe: () => Stream.die("unused subscription"),
        subscribeQueue: Effect.die("unused queue"),
        waitFor: () => Effect.never,
        subscribeWithHistory: () => Effect.never,
        waitForAny: () => Effect.never,
        query: () => Effect.succeed([]),
      }),
    ),
  );
  return { layer, calls, events, destroyOptions, destroyed, removed, eventRoots, selectedRoots, routeRoots };
};
