import { Effect, Layer } from "effect";

import { AppPlacementError, DebuggerHostUnavailableError, GlobalAppError } from "@lando/sdk/errors";
import { AppId } from "@lando/sdk/schema";
import { type ConfigService, GlobalAppService, RuntimeProviderRegistry } from "@lando/sdk/services";

import {
  type EnsureGlobalServicesServices,
  ensureGlobalServicesRunning,
} from "../operations/ensure-global-services.ts";
import { taggedErrorRemediation } from "../providers/managed.ts";
import { globalCreateProviderId, globalObserveProviderId } from "./placement.ts";

export const layer = Layer.effect(
  GlobalAppService,
  Effect.gen(function* () {
    const globalApp = yield* GlobalAppService;
    const registry = yield* RuntimeProviderRegistry;
    const context = yield* Effect.context<EnsureGlobalServicesServices | ConfigService>();
    const observedProviderId = globalObserveProviderId.pipe(Effect.provide(context));
    const observedProvider = observedProviderId.pipe(Effect.flatMap((id) => registry.select(id)));
    const createProvider = globalCreateProviderId().pipe(
      Effect.provide(context),
      Effect.flatMap((id) => registry.select(id)),
    );
    return GlobalAppService.of({
      ...globalApp,
      providerId: observedProviderId.pipe(
        Effect.mapError(
          (cause) =>
            new GlobalAppError({
              message: "Unable to resolve the global runtime provider.",
              operation: "placement",
              remediation:
                taggedErrorRemediation(cause) ??
                "Run `lando setup` and ensure a runtime provider is selected, then retry.",
              cause,
            }),
        ),
      ),
      ensureProviderReady: createProvider.pipe(
        Effect.flatMap((provider) => provider.ensureReady ?? Effect.void),
        Effect.mapError((cause) =>
          cause instanceof AppPlacementError
            ? cause
            : new GlobalAppError({
                message: "Unable to start the global service runtime before port selection.",
                operation: "ensureProviderReady",
                remediation:
                  taggedErrorRemediation(cause) ??
                  "Run `lando doctor` and fix the selected runtime provider, then retry.",
                cause,
              }),
        ),
      ),
      occupiedPublishPorts: (ports) =>
        createProvider.pipe(
          Effect.flatMap((provider) => provider.occupiedPublishPorts?.(ports) ?? Effect.succeed([])),
          Effect.mapError((cause) =>
            cause instanceof AppPlacementError
              ? cause
              : new GlobalAppError({
                  message: "Unable to inspect provider-host published TCP ports.",
                  operation: "occupiedPublishPorts",
                  remediation:
                    taggedErrorRemediation(cause) ??
                    "Run `lando doctor` and fix the selected runtime provider, then retry.",
                  cause,
                }),
          ),
        ),
      ownedPublishPorts: (serviceId, ports) =>
        observedProvider.pipe(
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
                    const published = ports.filter(
                      (port) =>
                        service.publications.status === "present" &&
                        service.publications.bindings.some(
                          (binding) => binding.transport === "tcp" && binding.hostPort === port,
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
                  taggedErrorRemediation(cause) ??
                  "Run `lando doctor` and fix the selected runtime provider, then retry.",
                cause,
              }),
          ),
        ),
      restartRunningService: (serviceId) =>
        observedProvider.pipe(
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
                  taggedErrorRemediation(cause) ??
                  "Run `lando doctor` and fix the selected runtime provider, then retry.",
                cause,
              }),
          ),
        ),
      ensureRunning: (services) =>
        ensureGlobalServicesRunning({ services }).pipe(
          Effect.provide(context),
          Effect.map((result) => result.servicesStarted),
          Effect.mapError((cause) =>
            cause instanceof AppPlacementError || cause instanceof DebuggerHostUnavailableError
              ? cause
              : new GlobalAppError({
                  message: "Unable to ensure global services are running.",
                  operation: "ensureRunning",
                  remediation:
                    taggedErrorRemediation(cause) ??
                    "Lando tried to install and start the required global services automatically. Fix the underlying error, then retry.",
                  cause,
                }),
          ),
        ),
    });
  }),
);
