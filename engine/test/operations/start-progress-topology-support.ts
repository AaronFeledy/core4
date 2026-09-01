import { DateTime, Effect, Layer, Schema, Stream } from "effect";

import type { ProviderUnavailableError } from "@lando/sdk/errors";
import { type LandoEvent, LandoEvent as LandoEventSchema } from "@lando/sdk/events";
import {
  AbsolutePath,
  AppId,
  type AppPlan,
  type ProviderCapabilities,
  ProviderId,
  ServiceName,
  type ServicePlan,
} from "@lando/sdk/schema";
import {
  AppPlanner,
  BuildOrchestrator,
  EventService,
  FileSyncEngine,
  LandofileService,
  PathsService,
  PluginRegistry,
  RouterService,
  RuntimeProviderRegistry,
  type RuntimeProviderShape,
  type ServiceRuntimeInfo,
} from "@lando/sdk/services";
import { TestRouterService, TestRuntimeProvider } from "@lando/sdk/test";

import { makeLandoPaths } from "@lando/paths";
import { RedactionService, createStandaloneRedactor } from "@lando/redaction/service";
import { GlobalAppServiceLive } from "../../src/global-app/service.ts";
import { applyTreeId } from "../../src/operations/start-progress.ts";
import { startApp } from "../../src/operations/start.ts";
import { ConfigServiceLive } from "../../src/services/config.ts";
import { FileSystemLive } from "../../src/services/file-system.ts";
import { makeShellRunnerLive } from "../../src/services/shell-runner.ts";

const providerId = ProviderId.make("lando");

const capabilities: ProviderCapabilities = {
  ...TestRuntimeProvider.capabilities,
  multiServiceApply: true,
  hostReachability: "emulated",
  bindMounts: true,
  bindMountPerformance: "native",
  hostProxy: { containerTargets: [{ os: "linux", arch: "x64" }] },
};

const metadata = {
  resolvedAt: DateTime.unsafeMake("2026-05-15T00:00:00Z"),
  source: "start-progress-topology.test",
  runtime: 4 as const,
};

export const web: ServicePlan = {
  name: ServiceName.make("web"),
  type: "node",
  provider: providerId,
  primary: true,
  artifact: { kind: "ref", ref: "node:22-alpine" },
  command: ["node", "server.js"],
  environment: {},
  mounts: [],
  storage: [],
  endpoints: [
    {
      _tag: "published",
      port: 3000,
      protocol: "http",
      name: "http",
      publication: { hostPort: 3000 },
    },
  ],
  routes: [],
  dependsOn: [],
  hostAliases: [],
  metadata,
  extensions: {},
};

export const plan: AppPlan = {
  id: AppId.make("test-start"),
  name: "test-start",
  slug: "test-start",
  root: AbsolutePath.make("/tmp/test-start"),
  provider: providerId,
  services: { [web.name]: web },
  routes: [],
  networks: [],
  stores: [],
  fileSync: [],
  metadata,
  extensions: {},
};

export const byTag = <T extends LandoEvent["_tag"]>(events: ReadonlyArray<LandoEvent>, tag: T) =>
  events.filter((event): event is Extract<LandoEvent, { readonly _tag: T }> => event._tag === tag);

export const startOwnedParentIds = (events: ReadonlyArray<LandoEvent>): ReadonlyArray<string> =>
  byTag(events, "task.tree.start")
    .map((event) => event.parentId)
    .filter((parentId) => parentId.startsWith("start-"));

export const makeHarness = (
  options: {
    readonly plannedApp?: AppPlan;
    readonly applyEffect?: Effect.Effect<{ readonly changed: boolean }, ProviderUnavailableError>;
    readonly fileSync?: typeof FileSyncEngine.Service;
  } = {},
) => {
  const plannedApp = options.plannedApp ?? plan;
  const events: LandoEvent[] = [];
  let signalApplyTreeStart = (): void => undefined;
  const applyTreeStarted = new Promise<void>((resolve) => {
    signalApplyTreeStart = resolve;
  });
  const provider: RuntimeProviderShape = {
    ...TestRuntimeProvider,
    id: "lando",
    capabilities,
    isAvailable: Effect.succeed(true),
    apply: () => options.applyEffect ?? Effect.succeed({ changed: true }),
    inspect: (target) =>
      Effect.succeed<ServiceRuntimeInfo>({
        app: plannedApp.id,
        service: target.service,
        providerId,
        status: "running",
        state: "running",
        endpoints: plannedApp.services[target.service]?.endpoints ?? [],
      }),
    destroy: () => Effect.void,
    execStream: () => Stream.empty,
    logs: () => Stream.empty,
  };
  const layer = Layer.mergeAll(
    Layer.succeed(LandofileService, { discover: Effect.succeed({ name: plannedApp.name, services: {} }) }),
    Layer.succeed(PathsService, makeLandoPaths()),
    Layer.succeed(AppPlanner, { plan: () => Effect.succeed(plannedApp) }),
    Layer.succeed(RuntimeProviderRegistry, {
      list: Effect.succeed([providerId]),
      capabilities: Effect.succeed(capabilities),
      select: () => Effect.succeed(provider),
    }),
    Layer.succeed(EventService, {
      publish: (event) =>
        Schema.is(LandoEventSchema)(event)
          ? Effect.sync(() => {
              events.push(event);
              if (event._tag === "task.tree.start" && event.parentId === applyTreeId(String(plannedApp.id))) {
                signalApplyTreeStart();
              }
            })
          : Effect.die(new TypeError(`Unexpected event in start progress topology test: ${event._tag}`)),
      subscribe: () => Effect.die("not used"),
      subscribeQueue: Effect.die("not used"),
      waitFor: () => Effect.die("not used"),
      waitForAny: () => Effect.die("not used"),
      query: () => Effect.succeed([]),
    }),
    Layer.succeed(RedactionService, {
      forProfile: (profile, redactionOptions) =>
        Effect.succeed(createStandaloneRedactor(profile, redactionOptions)),
    }),
    Layer.succeed(PluginRegistry, {
      list: Effect.succeed([]),
      load: () => Effect.die("not used"),
      loadServiceType: () => Effect.die("not used"),
      loadServiceFeature: () => Effect.die("not used"),
      loadAppFeature: () => Effect.die("not used"),
    }),
    ConfigServiceLive,
    FileSystemLive,
    GlobalAppServiceLive.pipe(Layer.provide(Layer.mergeAll(ConfigServiceLive, FileSystemLive))),
    Layer.succeed(RouterService, TestRouterService),
    makeShellRunnerLive(() => {
      throw new TypeError("Interactive shell IO is not used by start progress topology tests.");
    }),
    Layer.succeed(BuildOrchestrator, {
      build: (appPlan) => Effect.succeed(appPlan),
      buildApp: () => Effect.void,
    }),
    ...(options.fileSync === undefined ? [] : [Layer.succeed(FileSyncEngine, options.fileSync)]),
  );
  return { layer, events, applyTreeStarted };
};

export const runStart = (harness: ReturnType<typeof makeHarness>, plannedApp: AppPlan = plan) =>
  Effect.runPromise(
    startApp(
      {},
      {
        plan: plannedApp,
        root: plannedApp.root,
        app: { kind: "user", id: plannedApp.id, root: plannedApp.root },
      },
    ).pipe(Effect.provide(harness.layer)),
  );
