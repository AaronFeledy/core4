import {
  ownsAppliedGlobalService,
  resolveAppliedGlobalPlan,
} from "@lando/container-runtime/applied-global-service";
import { causeRemediation, mapFailures } from "@lando/sdk/command-result";
import { AppPlacementError, DebuggerHostUnavailableError, GlobalAppError } from "@lando/sdk/errors";
import {
  type ConfigService,
  GlobalAppService,
  PathsService,
  RuntimeProviderRegistry,
} from "@lando/sdk/services";
import { Effect, Layer } from "effect";

import {
  type EnsureGlobalServicesServices,
  ensureGlobalServicesRunning,
} from "../operations/ensure-global-services.ts";
import { requireOwningEngine } from "../providers/app-placement.ts";
import { prepareProvider } from "../providers/prepared.ts";
import { globalObserveProviderId, selectGlobalCreateProvider } from "./placement.ts";

export const layer = Layer.effect(
  GlobalAppService,
  Effect.gen(function* () {
    const globalApp = yield* GlobalAppService;
    const registry = yield* RuntimeProviderRegistry;
    const paths = yield* PathsService;
    const context = yield* Effect.context<EnsureGlobalServicesServices | ConfigService>();
    const observedProviderId = globalObserveProviderId.pipe(Effect.provide(context));
    const observedProvider = observedProviderId.pipe(Effect.flatMap((id) => registry.select(id)));
    const ownedServices = (onlyRunning: boolean) =>
      observedProvider.pipe(
        Effect.flatMap(
          Effect.fnUntraced(function* (provider) {
            const { root } = yield* globalApp.paths;
            const plan = yield* resolveAppliedGlobalPlan(registry, {
              appRoot: root,
              dataRoot: paths.roots.userDataRoot,
            });
            yield* requireOwningEngine(provider, "global", [plan]);
            const online = !onlyRunning || (yield* provider.getStatus).state !== "idle";
            const services =
              online && plan?.provider === provider.id
                ? (yield* provider.list({ app: plan.id })).filter((service) =>
                    ownsAppliedGlobalService(plan, service),
                  )
                : [];
            return { provider, services, plan };
          }),
        ),
      );
    const createProvider = selectGlobalCreateProvider().pipe(
      Effect.provide(context),
      Effect.map(({ provider }) => provider),
    );
    return GlobalAppService.of({
      ...globalApp,
      providerId: observedProviderId.pipe(
        mapFailures(
          (cause) =>
            new GlobalAppError({
              message: "Unable to resolve the global runtime provider.",
              operation: "placement",
              remediation:
                causeRemediation(cause) ??
                "Run `lando setup` and ensure a runtime provider is selected, then retry.",
              cause,
            }),
        ),
      ),
      ensureProviderReady: createProvider.pipe(
        Effect.flatMap(prepareProvider),
        Effect.asVoid,
        mapFailures((cause) =>
          cause instanceof AppPlacementError
            ? cause
            : new GlobalAppError({
                message: "Unable to start the global service runtime before port selection.",
                operation: "ensureProviderReady",
                remediation:
                  causeRemediation(cause) ??
                  "Run `lando doctor` and fix the selected runtime provider, then retry.",
                cause,
              }),
        ),
      ),
      occupiedPublishPorts: (ports) =>
        createProvider.pipe(
          Effect.flatMap((provider) => provider.occupiedPublishPorts?.(ports) ?? Effect.succeed([])),
          mapFailures((cause) =>
            cause instanceof AppPlacementError
              ? cause
              : new GlobalAppError({
                  message: "Unable to inspect provider-host published TCP ports.",
                  operation: "occupiedPublishPorts",
                  remediation:
                    causeRemediation(cause) ??
                    "Run `lando doctor` and fix the selected runtime provider, then retry.",
                  cause,
                }),
          ),
        ),
      ownedPublishPorts: (serviceId, ports) =>
        ownedServices(false).pipe(
          Effect.flatMap(({ provider, services }) =>
            Effect.gen(function* () {
              const owned = new Set<number>();
              for (const service of services) {
                if (service.service !== serviceId) continue;
                const running = service.status === "running";
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
          mapFailures(
            (cause) =>
              new GlobalAppError({
                message: "Unable to inspect Lando-owned global service ports.",
                operation: "ownedPublishPorts",
                remediation:
                  causeRemediation(cause) ??
                  "Run `lando doctor` and fix the selected runtime provider, then retry.",
                cause,
              }),
          ),
        ),
      restartRunningService: (serviceId) =>
        ownedServices(true).pipe(
          Effect.flatMap(
            Effect.fnUntraced(function* ({ provider, services, plan }) {
              return plan !== undefined &&
                services.some((service) => service.service === serviceId && service.status === "running")
                ? yield* provider.restart({ app: plan.id, service: serviceId, plan }).pipe(Effect.as(true))
                : false;
            }),
          ),
          mapFailures(
            (cause) =>
              new GlobalAppError({
                message: "Unable to reload the running global service.",
                operation: "restartRunningService",
                remediation:
                  causeRemediation(cause) ??
                  "Run `lando doctor` and fix the selected runtime provider, then retry.",
                cause,
              }),
          ),
        ),
      ensureRunning: (services) =>
        ensureGlobalServicesRunning({ services }).pipe(
          Effect.provide(context),
          Effect.map((result) => result.servicesStarted),
          mapFailures((cause) =>
            cause instanceof AppPlacementError || cause instanceof DebuggerHostUnavailableError
              ? cause
              : new GlobalAppError({
                  message: "Unable to ensure global services are running.",
                  operation: "ensureRunning",
                  remediation:
                    causeRemediation(cause) ??
                    "Lando tried to install and start the required global services automatically. Fix the underlying error, then retry.",
                  cause,
                }),
          ),
        ),
    });
  }),
);
