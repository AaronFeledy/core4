import { causeRemediation, mapFailures } from "@lando/sdk/command-result";
import { AppPlacementError, RouteUrlBindingError, ScratchAppError } from "@lando/sdk/errors";
import type { AppPlan, RouterConfig } from "@lando/sdk/schema";
import { EnvironmentValueResolver, type RouterServiceShape, StateStore } from "@lando/sdk/services";
import { type Context, Effect } from "effect";
import { applyActivation } from "../lifecycle/activation-apply.ts";
import { prepareRouteUrlBindings } from "../lifecycle/route-url-bindings.ts";
import type { PreparedCertificates } from "../lifecycle/service-certificates.ts";
import { completeStartup } from "../lifecycle/startup-completion.ts";
import {
  type GlobalConsumerAdmissionServices,
  requiresGlobalConsumerAdmission,
  withGlobalConsumerAdmission,
} from "../operations/global-consumer-admission.ts";
import { verifyGlobalConsumerAdmission } from "../operations/global-consumer-lease.ts";
import type { PreparedRuntimeProvider } from "../providers/prepared.ts";
import {
  type PreparedDebuggerOverlay,
  prepareDebuggerOverlay,
  projectDebuggerOverlay,
} from "../subsystems/start-overlay-registry.ts";

export const applyScratchStartup = Effect.fn("ScratchApp.applyStartup")(function* (
  request: {
    readonly id: string;
    readonly plan: AppPlan;
    readonly certificates: PreparedCertificates;
    readonly landofileRouter?: RouterConfig;
    readonly preparedOverlays?: PreparedDebuggerOverlay;
  },
  services: {
    readonly provider: PreparedRuntimeProvider;
    readonly environmentResolver: typeof EnvironmentValueResolver.Service;
    readonly stateStore: typeof StateStore.Service;
    readonly router: RouterServiceShape;
    readonly admissionContext?: Context.Context<GlobalConsumerAdmissionServices>;
  },
) {
  const { id, plan } = request;
  const preparedOverlays = request.preparedOverlays ?? (yield* prepareDebuggerOverlay(plan));
  const runtimePlan = projectDebuggerOverlay(plan, preparedOverlays);
  const activate = Effect.gen(function* () {
    const routeUrls = yield* prepareRouteUrlBindings({
      plan: runtimePlan,
      routes: runtimePlan.routes,
      router: services.router,
    }).pipe(
      mapFailures((cause) =>
        cause instanceof RouteUrlBindingError
          ? cause
          : new ScratchAppError({
              operation: "start",
              message: cause.message,
              remediation: causeRemediation(cause) ?? "Repair the router and retry scratch startup.",
              cause,
            }),
      ),
    );
    const applied = yield* applyActivation({
      routeUrls,
      provider: services.provider,
      plan: runtimePlan,
      certificates: request.certificates,
      reconcile: false,
      beforeApply: verifyGlobalConsumerAdmission,
    }).pipe(
      Effect.provideService(EnvironmentValueResolver, services.environmentResolver),
      Effect.provideService(StateStore, services.stateStore),
      mapFailures(
        (cause) =>
          new ScratchAppError({
            operation: "start",
            message: `Unable to start scratch app ${id}.`,
            cause,
            remediation:
              causeRemediation(cause) ??
              "Run `lando doctor`, fix the provider failure, then retry scratch start.",
          }),
      ),
    );
    yield* completeStartup({
      policy: "scratch",
      routeUrls,
      provider: services.provider,
      plan: runtimePlan,
      id,
      services: Object.values(runtimePlan.services).map((service) => service.name),
      router: services.router,
      ...(request.landofileRouter === undefined ? {} : { landofileRouter: request.landofileRouter }),
    }).pipe(
      mapFailures((cause) =>
        // Route publication failures arrive already named as such; only readiness failures remain.
        cause instanceof AppPlacementError ||
        cause instanceof RouteUrlBindingError ||
        cause instanceof ScratchAppError
          ? cause
          : new ScratchAppError({
              operation: "start",
              message: `Unable to ready scratch app ${id}.`,
              cause,
              remediation:
                causeRemediation(cause) ??
                "Wait for services to become healthy, or run `lando doctor` and retry.",
            }),
      ),
    );
    return applied.credentialChanges;
  });
  if (!requiresGlobalConsumerAdmission(plan)) return yield* activate;
  if (services.admissionContext === undefined)
    return yield* Effect.fail(
      new ScratchAppError({
        operation: "start",
        message: `Global service admission is unavailable for scratch app ${id}.`,
        remediation:
          "Provide the global runtime services when constructing ScratchAppService before starting dependent scratch applications.",
      }),
    );
  return yield* withGlobalConsumerAdmission(
    {
      plan,
      ...(request.landofileRouter === undefined ? {} : { landofileRouter: request.landofileRouter }),
    },
    activate,
  ).pipe(
    Effect.provide(services.admissionContext),
    mapFailures((cause) =>
      cause instanceof AppPlacementError ||
      cause instanceof ScratchAppError ||
      cause instanceof RouteUrlBindingError
        ? cause
        : new ScratchAppError({
            operation: "start",
            message: `Required global services could not be admitted for scratch app ${id}.`,
            cause,
            remediation:
              causeRemediation(cause) ??
              "Inspect global service policy and restore the required services before retrying scratch startup.",
          }),
    ),
  );
});
