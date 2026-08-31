import { DateTime, Effect, Layer, Schema, Stream } from "effect";

import type { ProviderUnavailableError } from "@lando/sdk/errors";
import { type LandoEvent, LandoEvent as LandoEventSchema } from "@lando/sdk/events";
import {
  AbsolutePath,
  AppId,
  type AppPlan,
  ProviderId,
  ServiceName,
  type ServicePlan,
} from "@lando/sdk/schema";
import {
  EventService,
  FileSyncEngine,
  PathsService,
  RouterService,
  RuntimeProviderRegistry,
  type RuntimeProviderShape,
} from "@lando/sdk/services";
import { TestRouterService, TestRuntimeProvider } from "@lando/sdk/test";

import { makeLandoPaths } from "@lando/paths";
import { destroyTreeId } from "../../src/operations/destroy-progress.ts";
import { destroyAppForTarget } from "../../src/operations/destroy.ts";

export { destroyTreeId };

const providerId = ProviderId.make("lando");

const metadata = {
  resolvedAt: DateTime.unsafeMake("2026-05-15T00:00:00Z"),
  source: "destroy-progress-topology.test",
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
    { _tag: "published", port: 3000, protocol: "http", name: "http", publication: { hostPort: 3000 } },
  ],
  routes: [],
  dependsOn: [],
  hostAliases: [],
  metadata,
  extensions: {},
};

export const plan: AppPlan = {
  id: AppId.make("test-destroy"),
  name: "test-destroy",
  slug: "test-destroy",
  root: AbsolutePath.make("/tmp/test-destroy"),
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

export const makeHarness = (
  options: {
    readonly destroyEffect?: Effect.Effect<void, ProviderUnavailableError>;
    readonly proxyAvailable?: boolean;
    readonly fileSync?: typeof FileSyncEngine.Service;
  } = {},
) => {
  const events: LandoEvent[] = [];
  const provider: RuntimeProviderShape = {
    ...TestRuntimeProvider,
    id: "lando",
    destroy: () => options.destroyEffect ?? Effect.void,
    execStream: () => Stream.empty,
    logs: () => Stream.empty,
  };
  const layer = Layer.mergeAll(
    Layer.succeed(PathsService, makeLandoPaths({ env: {}, platform: "linux" })),
    Layer.succeed(RuntimeProviderRegistry, {
      list: Effect.succeed([providerId]),
      capabilities: Effect.succeed(TestRuntimeProvider.capabilities),
      select: () => Effect.succeed(provider),
    }),
    Layer.succeed(EventService, {
      publish: (event) =>
        Schema.is(LandoEventSchema)(event)
          ? Effect.sync(() => {
              events.push(event);
            })
          : Effect.die(new TypeError(`Unexpected event in destroy progress topology test: ${event._tag}`)),
      subscribe: () => Effect.die("not used"),
      subscribeQueue: Effect.die("not used"),
      waitFor: () => Effect.die("not used"),
      waitForAny: () => Effect.die("not used"),
      query: () => Effect.succeed([]),
    }),
    ...(options.proxyAvailable === false ? [] : [Layer.succeed(RouterService, TestRouterService)]),
    ...(options.fileSync === undefined ? [] : [Layer.succeed(FileSyncEngine, options.fileSync)]),
  );
  return { layer, events };
};

export const runDestroyTarget = (
  harness: ReturnType<typeof makeHarness>,
  options: Parameters<typeof destroyAppForTarget>[0] = {},
) =>
  Effect.runPromise(
    destroyAppForTarget(options, {
      plan,
      root: plan.root,
      app: { kind: "user", id: plan.id, root: plan.root },
    }).pipe(Effect.provide(harness.layer)),
  );
