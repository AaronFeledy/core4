import {
  AppPlacementError,
  GlobalAutoStartError,
  ProxySetupError,
  ServiceNotReadyError,
} from "@lando/sdk/errors";
import type { AppPlan, RouterConfig } from "@lando/sdk/schema";
import {
  AppPlanner,
  BuildOrchestrator,
  ConfigService,
  EnvironmentValueResolver,
  EventService,
  FileSystem,
  GlobalAppService,
  PathsService,
  PluginRegistry,
  RouterService,
  RuntimeProviderRegistry,
  StateStore,
} from "@lando/sdk/services";
import { PrivateFileAccessService } from "@lando/state-store/private-file-access";
import { Context, Effect } from "effect";

import { resolveProxyDefaultDomain } from "../config/proxy-default-domain.ts";
import { resolveRouterConfigForApp, routerEnabled } from "../config/router-config.ts";
import { withGlobalMutation } from "../global-app/mutation.ts";
import { globalCreateProviderId } from "../global-app/placement.ts";
import { withGlobalResolutionCapabilities } from "../global-app/resolution.ts";
import { mapFailureErrors } from "../lifecycle/failure-compensation.ts";
import { taggedErrorRemediation } from "../providers/managed.ts";
import { interruptOnAbort } from "../subsystems/healthcheck/attempt.ts";
import { unavailableRouterReason } from "../subsystems/proxy/api.ts";
import type { EnsureGlobalServicesServices } from "./ensure-global-services.ts";
import { ensureGlobalServicesRunning } from "./ensure-global-services.ts";
import { withGlobalConsumerAdmissionCheck, withGlobalConsumerReservation } from "./global-consumer-lease.ts";
import { readGlobalLandofile } from "./global-plan.ts";

export type GlobalConsumerAdmissionServices = EnsureGlobalServicesServices | RouterService;

/** Bind service implementations without replacing the caller's held-lock references. */
const admissionServices = [
  AppPlanner,
  BuildOrchestrator,
  EnvironmentValueResolver,
  EventService,
  FileSystem,
  GlobalAppService,
  PathsService,
  PluginRegistry,
  RouterService,
  RuntimeProviderRegistry,
  StateStore,
  PrivateFileAccessService,
] as const;

export const captureGlobalConsumerAdmission = Effect.gen(function* () {
  const context = yield* Effect.context<never>();
  const selected = Context.pick(...admissionServices, ConfigService)(context);
  if (admissionServices.some((service) => !selected.mapUnsafe.has(service.key))) return undefined;
  return Context.makeUnsafe<GlobalConsumerAdmissionServices>(selected.mapUnsafe);
});

export const requiresGlobalConsumerAdmission = (plan: AppPlan): boolean =>
  (plan.requires?.globalServices.length ?? 0) > 0 || (routerEnabled(plan) && plan.routes.length > 0);

/**
 * Fails with the router selection reason when the plan publishes routes and no router is
 * selectable, so a routed activation can refuse before it changes anything.
 */
export const requireSelectableRouter = Effect.fn("GlobalConsumerAdmission.requireSelectableRouter")(
  function* (plan: AppPlan): Effect.fn.Return<void, ProxySetupError, RouterService> {
    if (!routerEnabled(plan) || plan.routes.length === 0) return;
    const unavailable = unavailableRouterReason(yield* RouterService);
    if (unavailable === undefined) return;
    return yield* Effect.fail(
      new ProxySetupError({
        message: unavailable.message,
        proxyId: unavailable.proxyId,
        remediation: unavailable.remediation,
      }),
    );
  },
);

/**
 * Global activations publish the routes of the services they start once apply finishes; refuse
 * before any destroy, build, or apply when those routes need a router and none is selectable.
 */
export const requireSelectableGlobalRouter = (plan: AppPlan, services: ReadonlySet<string>) =>
  requireSelectableRouter({ ...plan, routes: plan.routes.filter((route) => services.has(route.service)) });

export interface GlobalConsumerAdmission {
  readonly plan: AppPlan;
  readonly signal?: AbortSignal;
  readonly landofileRouter?: RouterConfig;
  /** Selected restart/rebuild do not run the normal route-publication lifecycle. */
  readonly setupRouter?: boolean;
}

/** Keep final global admission and consumer activation indivisible to policy changes. */
export const withGlobalConsumerAdmission = Effect.fnUntraced(function* <A, E, R>(
  request: GlobalConsumerAdmission,
  body: Effect.Effect<A, E, R>,
) {
  const { plan, signal } = request;
  const routed = routerEnabled(plan) && plan.routes.length > 0;
  const required = new Set(plan.requires?.globalServices ?? []);
  if (!routed && required.size === 0) return yield* interruptOnAbort(body, signal);
  // Report why no router is selectable before comparing or requiring its identity.
  yield* requireSelectableRouter(plan);
  if (routed && plan.router?.id !== undefined) {
    const router = yield* RouterService;
    if (router.id !== plan.router.id)
      return yield* Effect.fail(
        new GlobalAutoStartError({
          app: plan.name,
          services: [...required],
          message: `Plan router ${plan.router.id} differs from the active router ${router.id}.`,
          remediation:
            "Retry startup to plan with the selected router, or restore defaultRouterService to the plan's router.",
        }),
      );
  }
  if (routed && plan.router?.id !== undefined && required.size === 0) {
    return yield* interruptOnAbort(
      Effect.gen(function* () {
        const router = yield* RouterService;
        const config = {
          defaultDomain: yield* resolveProxyDefaultDomain,
          ...(yield* resolveRouterConfigForApp(request.landofileRouter)),
        };
        if (router.prepare !== undefined) yield* router.prepare(config);
        if (request.setupRouter) yield* Effect.scoped(router.setup(config));
        return yield* body;
      }),
      signal,
    );
  }
  const failure = (cause: unknown) =>
    cause instanceof AppPlacementError ||
    cause instanceof ServiceNotReadyError ||
    cause instanceof GlobalAutoStartError
      ? cause
      : new GlobalAutoStartError({
          app: plan.name,
          services: [...required],
          message: `Global services required by ${plan.name} could not be admitted before activation.`,
          remediation:
            taggedErrorRemediation(cause) ??
            "Run `lando global:list`, repair or enable the required services, then retry application startup.",
          cause,
        });
  const outcome = yield* interruptOnAbort(
    withGlobalMutation(
      Effect.gen(function* () {
        const router = routed ? yield* RouterService : undefined;
        // Legacy applied plans have no selected identity; retain their authored requirements.
        if (router !== undefined && plan.router?.id === undefined) required.add(router.id);
        const config =
          router === undefined
            ? undefined
            : {
                defaultDomain: yield* resolveProxyDefaultDomain,
                ...(yield* resolveRouterConfigForApp(request.landofileRouter)),
              };
        if (router?.prepare !== undefined && config !== undefined) yield* router.prepare(config);
        const verify = Effect.gen(function* () {
          const providerId = yield* globalCreateProviderId();
          const registry = yield* RuntimeProviderRegistry;
          const provider = yield* registry.select(providerId);
          const current = yield* withGlobalResolutionCapabilities(
            providerId,
            provider.capabilities,
            readGlobalLandofile({ services: [...required] }),
          );
          if (
            !current.materialized ||
            [...required].some((id) => !Object.hasOwn(current.landofile.document.services ?? {}, id))
          )
            return yield* Effect.fail(
              new GlobalAutoStartError({
                app: plan.name,
                services: [...required],
                message: `Required global services changed before ${plan.name} could activate.`,
                remediation: "Inspect `lando global:list`, enable the required services, then retry startup.",
              }),
            );
          if (providerId !== plan.provider || provider.id !== String(providerId))
            return yield* Effect.fail(
              new AppPlacementError({
                app: {
                  kind: Object.hasOwn(plan.extensions, "@lando/core/scratch") ? "scratch" : "user",
                  id: plan.id,
                  root: plan.root,
                },
                desiredProviderId: plan.provider,
                realizedProviderId: providerId,
                message: `Application provider ${plan.provider} differs from the required global service provider ${providerId}.`,
                remediation: "Use the active global provider before starting this application.",
              }),
            );
        });
        const context = yield* captureGlobalConsumerAdmission;
        if (context === undefined)
          return yield* Effect.fail(failure(new Error("Global consumer admission services are incomplete.")));
        return yield* withGlobalConsumerReservation(
          plan,
          [...required],
          Effect.gen(function* () {
            yield* ensureGlobalServicesRunning({
              services: [...required],
              ...(signal === undefined ? {} : { signal }),
            });
            if (request.setupRouter && router !== undefined && config !== undefined)
              yield* Effect.scoped(router.setup(config));
            yield* verify;
            return yield* withGlobalConsumerAdmissionCheck(
              verify.pipe(mapFailureErrors(failure), Effect.provide(context)),
              Effect.exit(body),
            );
          }),
        );
      }),
    ).pipe(mapFailureErrors(failure)),
    signal,
  );
  return yield* outcome;
});
