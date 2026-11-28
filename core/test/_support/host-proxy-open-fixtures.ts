import { RedactionService, makeRedactionService } from "@lando/redaction/service";
import {
  AbsolutePath,
  AppId,
  type AppPlan,
  ProviderId,
  type RoutePlan,
  ServiceName,
} from "@lando/sdk/schema";
import {
  EventService,
  ProcessRunner,
  RouterService,
  RuntimeProviderRegistry,
  type RuntimeProviderShape,
} from "@lando/sdk/services";
import { TestRuntimeProvider, makeTestRouterService, makeTestRuntimeProviderRegistry } from "@lando/sdk/test";
import { DateTime, Effect, Layer, Stream } from "effect";

export const route = (
  over: Pick<RoutePlan, "hostname" | "scheme"> & { readonly service: string },
): RoutePlan => ({
  priority: 2,
  ...over,
  service: ServiceName.make(over.service),
  backend: { service: ServiceName.make(over.service), protocol: "http", port: 80 },
});

export const makePlan = (routes: RoutePlan[], serviceNames: string[]): AppPlan => {
  const metadata = { resolvedAt: DateTime.makeUnsafe(0), source: "host-proxy-open", runtime: 4 as const };
  return {
    id: AppId.make("myapp"),
    name: "myapp",
    slug: "myapp",
    root: AbsolutePath.make("/srv/apps/myapp"),
    provider: ProviderId.make("test"),
    services: Object.fromEntries(
      serviceNames.map((name) => [
        name,
        {
          name: ServiceName.make(name),
          provider: ProviderId.make("test"),
          type: "generic",
          primary: true,
          environment: {},
          mounts: [],
          routes: [],
          endpoints: [{ kind: "internal", protocol: "http", port: 80, name: "http", primary: true }],
          dependsOn: [],
          hostAliases: [],
          metadata,
          extensions: {},
        },
      ]),
    ),
    routes,
    stores: [],
    fileSync: [],
    metadata,
    extensions: {},
  };
};

export const silentEventLayer = () =>
  Layer.succeed(
    EventService,
    EventService.of({
      publish: () => Effect.void,
      subscribe: () => Stream.die("unused event subscription"),
      subscribeQueue: Effect.die("unused event queue"),
      waitFor: () => Effect.die("unused event wait"),
      subscribeWithHistory: () => Effect.never,
      waitForAny: () => Effect.die("unused event wait"),
      query: () => Effect.die("unused event query"),
    }),
  );

export const redactionLayer = () => Layer.succeed(RedactionService, makeRedactionService());

const observedProvider: RuntimeProviderShape = {
  ...TestRuntimeProvider,
  inspect: (target) =>
    Effect.succeed({
      app: target.app,
      service: target.service,
      providerId: ProviderId.make("test"),
      status: "running",
      publications: { status: "present", bindings: [] },
    }),
};

export const commandServices = (
  eventLayer: Layer.Layer<EventService>,
  httpsPort = 443,
  provider: RuntimeProviderShape = observedProvider,
) =>
  Layer.mergeAll(
    Layer.succeed(
      ProcessRunner,
      ProcessRunner.of({
        run: () => Effect.succeed({ exitCode: 0, stdout: "", stderr: "" }),
        stream: () => Stream.die("unused process stream"),
        streamWithExit: () => Stream.die("unused process stream"),
      }),
    ),
    eventLayer,
    redactionLayer(),
    Layer.succeed(
      RuntimeProviderRegistry,
      makeTestRuntimeProviderRegistry({
        list: Effect.succeed([ProviderId.make("test")]),
        capabilities: Effect.succeed(provider.capabilities),
        select: () => Effect.succeed(provider),
      }),
    ),
    Layer.succeed(
      RouterService,
      RouterService.of({
        ...makeTestRouterService(),
        status: Effect.die("open must not infer liveness from router status"),
        observeRoutes: () =>
          Effect.succeed({
            configuredAuthorities: [{ hostname: "web.myapp.lndo.site", scheme: "https", port: httpsPort }],
            observation: {
              status: "present",
              publications: [
                {
                  route: route({ hostname: "web.myapp.lndo.site", scheme: "https", service: "web" }),
                  authority: { hostname: "web.myapp.lndo.site", scheme: "https", port: httpsPort },
                },
              ],
            },
          }),
      }),
    ),
  );
