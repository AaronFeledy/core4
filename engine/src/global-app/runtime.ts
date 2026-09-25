import { Context, Effect, Layer } from "effect";

import { GlobalAppError } from "@lando/sdk/errors";
import { AppId } from "@lando/sdk/schema";
import {
  AppPlanner,
  BuildOrchestrator,
  ConfigService,
  EventService,
  FileSystem,
  GlobalAppService,
  PluginRegistry,
  RuntimeProviderRegistry,
} from "@lando/sdk/services";

import { ensureGlobalServicesRunning } from "../operations/ensure-global-services.ts";
import { MANAGED_PROVIDER_SELECT_PLAN, taggedErrorRemediation } from "../providers/managed.ts";

export const GlobalAppRuntimeLive = Layer.effect(
  GlobalAppService,
  Effect.gen(function* () {
    const globalApp = yield* GlobalAppService;
    const registry = yield* RuntimeProviderRegistry;
    const context = Context.make(GlobalAppService, globalApp).pipe(
      Context.add(AppPlanner, yield* AppPlanner),
      Context.add(BuildOrchestrator, yield* BuildOrchestrator),
      Context.add(ConfigService, yield* ConfigService),
      Context.add(EventService, yield* EventService),
      Context.add(FileSystem, yield* FileSystem),
      Context.add(PluginRegistry, yield* PluginRegistry),
      Context.add(RuntimeProviderRegistry, yield* RuntimeProviderRegistry),
    );
    return {
      ...globalApp,
      ensureProviderReady: registry.select(MANAGED_PROVIDER_SELECT_PLAN).pipe(
        Effect.flatMap((provider) => provider.ensureReady ?? Effect.void),
        Effect.mapError(
          (cause) =>
            new GlobalAppError({
              message: "Unable to start the global service runtime before port selection.",
              operation: "ensureProviderReady",
              remediation: taggedErrorRemediation(cause) ?? "Check the selected runtime provider and retry.",
              cause,
            }),
        ),
      ),
      occupiedPublishPorts: (ports) =>
        registry.select(MANAGED_PROVIDER_SELECT_PLAN).pipe(
          Effect.flatMap((provider) => provider.occupiedPublishPorts?.(ports) ?? Effect.succeed([])),
          Effect.mapError(
            (cause) =>
              new GlobalAppError({
                message: "Unable to inspect provider-host published TCP ports.",
                operation: "occupiedPublishPorts",
                remediation:
                  taggedErrorRemediation(cause) ?? "Check the selected runtime provider and retry.",
                cause,
              }),
          ),
        ),
      ownedPublishPorts: (serviceId, ports) =>
        registry.select(MANAGED_PROVIDER_SELECT_PLAN).pipe(
          Effect.flatMap((provider) =>
            provider.list({ app: AppId.make("global") }).pipe(
              Effect.flatMap((services) =>
                Effect.gen(function* () {
                  const owned = new Set<number>();
                  for (const service of services) {
                    if (service.service !== serviceId) continue;
                    const running = (service.state ?? service.status).toLowerCase() === "running";
                    // Only a provider with an explicit ownership validator may
                    // reserve a stopped service's persisted pair. Providers
                    // without that capability retain running-only behavior.
                    if (!running && provider.matchingPublishPorts === undefined) continue;
                    const published = ports.filter((port) =>
                      (service.endpoints ?? []).some(
                        (endpoint) =>
                          endpoint._tag === "published" &&
                          (endpoint.materialization?.hostPort ?? endpoint.publication?.hostPort) === port,
                      ),
                    );
                    if (published.length === 0) continue;
                    const verified =
                      provider.matchingPublishPorts === undefined
                        ? published
                        : service.containerId === undefined
                          ? []
                          : yield* provider.matchingPublishPorts(service.containerId, published);
                    for (const port of verified) owned.add(port);
                  }
                  return ports.filter((port) => owned.has(port));
                }),
              ),
            ),
          ),
          Effect.mapError(
            (cause) =>
              new GlobalAppError({
                message: "Unable to inspect Lando-owned global service ports.",
                operation: "ownedPublishPorts",
                remediation:
                  taggedErrorRemediation(cause) ?? "Check the selected runtime provider and retry.",
                cause,
              }),
          ),
        ),
      restartRunningService: (serviceId) =>
        registry.select(MANAGED_PROVIDER_SELECT_PLAN).pipe(
          Effect.flatMap((provider) =>
            provider
              .list({ app: AppId.make("global") })
              .pipe(
                Effect.flatMap((services) =>
                  services.some(
                    (service) =>
                      service.service === serviceId &&
                      (service.state ?? service.status).toLowerCase() === "running",
                  )
                    ? provider
                        .restart({ app: AppId.make("global"), service: serviceId })
                        .pipe(Effect.as(true))
                    : Effect.succeed(false),
                ),
              ),
          ),
          Effect.mapError(
            (cause) =>
              new GlobalAppError({
                message: "Unable to reload the running global service.",
                operation: "restartRunningService",
                remediation:
                  taggedErrorRemediation(cause) ?? "Check the selected runtime provider and retry.",
                cause,
              }),
          ),
        ),
      ensureRunning: (services) =>
        ensureGlobalServicesRunning({ services }).pipe(
          Effect.provide(context),
          Effect.map((result) => result.servicesStarted),
          Effect.mapError(
            (cause) =>
              new GlobalAppError({
                message: "Unable to ensure global services are running.",
                operation: "ensureRunning",
                remediation:
                  taggedErrorRemediation(cause) ??
                  "Lando tried to install and start the required global services automatically. Fix the underlying error, then retry.",
                cause,
              }),
          ),
        ),
    };
  }),
);
