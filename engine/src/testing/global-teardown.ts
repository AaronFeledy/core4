import { join } from "node:path";
import * as BunFileSystem from "@lando/engine/services/file-system";

import { makeLandoPaths } from "@lando/paths";
import { mapFailures } from "@lando/sdk/command-result";
import { ProviderUnavailableError, ProxyError } from "@lando/sdk/errors";
import {
  AbsolutePath,
  AppId,
  type AppPlan,
  AppRef,
  type AppRouteOwner,
  type HealthcheckPlan,
  ProviderId,
  ServiceName,
  type VolumeInfo,
  appIdentityKey,
} from "@lando/sdk/schema";
import type { LandoEvent, RuntimeProviderShape } from "@lando/sdk/services";
import {
  type BringDownOptions,
  type BringDownOutcome,
  type ContainerDisposition,
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
import { TestRuntimeProvider, makeTestRouterService, makeTestRuntimeProviderRegistry } from "@lando/sdk/test";
import { PrivateFileAccessService } from "@lando/state-store/private-file-access";
import { makeStateStore } from "@lando/state-store/service";
import { DateTime, Effect, Layer, Schema, Stream } from "effect";
import { CertificateAuthorityResolver } from "../plugins/certificate-authority-resolver.ts";
import { RouterServiceRegistry } from "../subsystems/proxy/registry.ts";

export const globalPlanAt = (root: AbsolutePath, readiness?: HealthcheckPlan): AppPlan => ({
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
      ...(readiness === undefined ? {} : { readiness }),
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
    readonly engineIdentity?: RuntimeProviderShape["engineIdentity"];
    readonly orphanRoot?: AbsolutePath;
    readonly volumes?: ReadonlyArray<VolumeInfo>;
    readonly destroyOutcome?: BringDownOutcome;
    readonly stopOutcome?: BringDownOutcome;
    readonly availability?: Effect.Effect<boolean, ProviderUnavailableError>;
    readonly status?: RuntimeProviderShape["getStatus"];
    readonly inspectAppliedFileSync?: RuntimeProviderShape["inspectAppliedFileSync"];
    readonly ensureReady?: RuntimeProviderShape["ensureReady"] | null;
    readonly appliedPlans?: Effect.Effect<ReadonlyArray<AppPlan>, ProviderUnavailableError>;
    readonly services?: ReadonlyArray<ServiceRuntimeInfo>;
    readonly stopFailure?: boolean;
    readonly routeFailure?: boolean;
    readonly routers?: "selectable" | "unselectable" | "uninstalled";
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
  const destroyOptions: BringDownOptions[] = [];
  const destroyed: AppPlan[] = [];
  const removed: ServiceRuntimeInfo[] = [];
  const stopped: ServiceRuntimeInfo[] = [];
  const stoppedPlans: AppPlan[] = [];
  const eventRoots: string[] = [];
  const selectedRoots: string[] = [];
  const routeRoots: string[] = [];
  const builtRoots: string[] = [];
  const routeOwners: AppRouteOwner[] = [];
  let prepared = false;
  const provider = {
    ...TestRuntimeProvider,
    ...(input.engineIdentity === undefined ? {} : { engineIdentity: input.engineIdentity }),
    id: "lando",
    appliedPlans: input.appliedPlans ?? Effect.succeed(input.plan === undefined ? [] : [input.plan]),
    isAvailable: input.availability ?? Effect.succeed(true),
    getStatus: Effect.suspend((): RuntimeProviderShape["getStatus"] =>
      prepared
        ? Effect.succeed({ state: "running" as const })
        : (input.status ?? Effect.succeed({ state: "running" as const })),
    ),
    ...(input.inspectAppliedFileSync === undefined
      ? {}
      : { inspectAppliedFileSync: input.inspectAppliedFileSync }),
    ...(input.ensureReady === null
      ? {}
      : {
          ensureReady:
            input.ensureReady ??
            Effect.sync(() => {
              calls.push("ensureReady");
            }).pipe(
              Effect.tap(() =>
                Effect.sync(() => {
                  prepared = true;
                }),
              ),
            ),
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
            labels: {
              "dev.lando.app": "global",
              "dev.lando.app-root": input.orphanRoot,
              "dev.lando.service": "ssh-agent",
            },
          },
        ];
      }),
    listVolumes: () =>
      Effect.sync(() => {
        calls.push("listVolumes");
        return input.volumes ?? [];
      }),
    bringDown: (target: { readonly plan?: AppPlan }, options: BringDownOptions) =>
      Effect.sync((): BringDownOutcome => {
        calls.push("bringDown");
        destroyOptions.push(options);
        if (options.containers === "stop") {
          if (target.plan !== undefined) stoppedPlans.push(target.plan);
          return (
            input.stopOutcome ?? {
              kind: "stopped",
              containers: Object.values(target.plan?.services ?? {}).map((service) => ({
                service: service.name,
                containerId: `${service.name}-container`,
                action: "stopped" as const,
              })),
            }
          );
        }
        if (target.plan !== undefined) destroyed.push(target.plan);
        return (
          input.destroyOutcome ?? { kind: "removed", containers: [], volumesRemoved: { data: 0, cache: 0 } }
        );
      }),
    bringDownObserved: Effect.fnUntraced(function* (
      service: ServiceRuntimeInfo,
      containers: ContainerDisposition,
    ) {
      calls.push("bringDownObserved");
      if (input.stopFailure)
        return yield* Effect.fail(
          new ProviderUnavailableError({
            message: "bring-down failed",
            providerId: "lando",
            operation: "bringDownObserved",
            remediation: "Bring-down failed",
          }),
        );
      const containerId = service.containerId;
      if (containers === "stop") {
        if (containerId === undefined) return { service: service.service, action: "absent" as const };
        if (service.status !== "running")
          return { service: service.service, containerId, action: "already-stopped" as const };
        stopped.push(service);
        return { service: service.service, containerId, action: "stopped" as const };
      }
      removed.push(service);
      return { service: service.service, action: "removed" as const };
    }),
    removeVolume: () =>
      Effect.sync(() => {
        calls.push("removeVolume");
      }),
  };
  const fileSystem = await Effect.runPromise(FileSystem.pipe(Effect.provide(BunFileSystem.layer)));
  const router = RouterService.of({
    ...makeTestRouterService(),
    stop: Effect.die("Global lifecycle must not stop the shared router"),
    removeRoutes: Effect.fnUntraced(function* (owner) {
      calls.push("removeRoutes");
      routeOwners.push(owner);
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
        mapFailures(
          (cause) =>
            new ProxyError({
              proxyId: router.id,
              message: cause.message,
              remediation: cause.remediation,
              cause,
            }),
        ),
      )).root;
      builtRoots.push(capturedRoot);
      return RouterService.of({
        ...router,
        removeRoutes: (owner) => {
          routeRoots.push(capturedRoot);
          return router.removeRoutes(owner);
        },
      });
    }),
  );
  const layer = Layer.mergeAll(
    Layer.succeed(CertificateAuthorityResolver, {
      resolve: Effect.die("No certificate issuance during teardown"),
    }),
    Layer.succeed(RouterServiceRegistry, {
      list: Effect.succeed(input.routers === "uninstalled" ? [] : [router.id]),
      select: (selection) =>
        input.routers === "uninstalled" ||
        (input.routers === "unselectable" && selection?.explicit !== router.id)
          ? Effect.fail(
              new ProxyError({
                proxyId: "missing",
                message: "Router service missing is not installed.",
                remediation: "Configure `defaultRouterService` to an installed id.",
              }),
            )
          : Effect.succeed({ id: router.id, layer: routerLayer }),
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
      makeTestRuntimeProviderRegistry({
        appliedPlansFor: () => provider.appliedPlans,
        appliedStateInventory: () =>
          Effect.map(provider.appliedPlans, (plans) => ({ plans, unreadable: [] })),
        readAppliedPlanStrict: ({ id }) =>
          Effect.map(provider.appliedPlans, (plans) => plans.find((plan) => plan.id === id)),
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
      removeRoutes: (owner) => {
        routeRoots.push(root);
        return router.removeRoutes(owner);
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
  return {
    layer,
    calls,
    events,
    destroyOptions,
    destroyed,
    removed,
    stopped,
    stoppedPlans,
    eventRoots,
    selectedRoots,
    routeRoots,
    builtRoots,
    routeOwners,
  };
};
