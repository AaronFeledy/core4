import type { GlobalAppError } from "@lando/sdk/errors";
import type { AppPlan, RouterConfig, ServicePlan } from "@lando/sdk/schema";
import type { BuildOrchestrator, RouterServiceShape } from "@lando/sdk/services";
import type { ProgressEmitter } from "@lando/sdk/task-progress";
import { Effect } from "effect";
import { verifyGlobalConsumerAdmission } from "../operations/global-consumer-lease.ts";
import { waitForServiceReadiness } from "../operations/service-readiness.ts";
import { startFileSyncSessions } from "../operations/start-file-sync.ts";
import { withRoutesStartProgress } from "../operations/start-progress-phases.ts";
import { withActivationObservations } from "../services/build-app-observation.ts";
import { withBuildProvider } from "../services/build-orchestrator.ts";
import { applyAppRoutes } from "./routes.ts";
import { completeGlobalGroups } from "./startup-completion-groups.ts";
import { applyScratchRoutes } from "./startup-completion-scratch.ts";

type Readiness = Parameters<typeof waitForServiceReadiness>[0];
type UserStart = Readiness & {
  readonly policy: "user-start";
  readonly builds: typeof BuildOrchestrator.Service;
  readonly router: RouterServiceShape;
  readonly events: ProgressEmitter;
  readonly landofileRouter?: RouterConfig;
  readonly forceAppBuild?: boolean;
};
type Selected = Readiness & {
  readonly policy: "selected";
  readonly selectedPlan: AppPlan;
  /** The composed table whose routes are published, including unselected applied routes. */
  readonly routePlan: AppPlan;
  readonly builds: typeof BuildOrchestrator.Service;
  readonly router: RouterServiceShape;
  readonly events: ProgressEmitter;
  readonly landofileRouter?: RouterConfig;
  readonly forceAppBuild?: boolean;
};
type EnsureGlobal = Readiness & { readonly policy: "ensure-global" };
type Scratch = Readiness & {
  readonly policy: "scratch";
  readonly router?: RouterServiceShape;
  readonly landofileRouter?: RouterConfig;
};
export type GlobalGroups<E> = {
  readonly policy: "global-groups";
  readonly operation: "start" | "rebuild";
  readonly beforeRoutes?: Effect.Effect<void, GlobalAppError>;
  readonly provider: Readiness["provider"];
  readonly router: RouterServiceShape;
  readonly outcome: {
    readonly builtPlan: AppPlan;
    readonly services: ReadonlyArray<ServicePlan>;
    readonly failures: ReadonlyArray<{ readonly names: ReadonlyArray<string>; readonly error: E }>;
  };
  readonly signal?: AbortSignal;
};

const userStart = Effect.fn("StartupCompletion.userStart")(function* (request: UserStart) {
  yield* withBuildProvider(
    withActivationObservations(
      request.builds.buildApp(request.plan, {
        ...(request.forceAppBuild === true ? { force: true } : {}),
        ...(request.signal === undefined ? {} : { signal: request.signal }),
      }),
      request.initial,
    ),
    request.provider,
  );
  yield* verifyGlobalConsumerAdmission;
  const routes = applyAppRoutes(request.router, request.plan, request.events, request.landofileRouter);
  yield* request.plan.routes.length === 0
    ? routes
    : withRoutesStartProgress({ events: request.events, plan: request.plan, work: routes });
  return yield* waitForServiceReadiness(request);
});
const selected = Effect.fn("StartupCompletion.selected")(function* (request: Selected) {
  yield* startFileSyncSessions(request.selectedPlan, request.events);
  yield* withBuildProvider(
    withActivationObservations(
      request.builds.buildApp(request.selectedPlan, {
        ...(request.forceAppBuild === true ? { force: true } : {}),
        ...(request.signal === undefined ? {} : { signal: request.signal }),
      }),
      request.initial,
    ),
    request.provider,
  );
  yield* verifyGlobalConsumerAdmission;
  const routes = applyAppRoutes(request.router, request.routePlan, request.events, request.landofileRouter);
  yield* request.routePlan.routes.length === 0
    ? routes
    : withRoutesStartProgress({ events: request.events, plan: request.routePlan, work: routes });
  return yield* waitForServiceReadiness(request);
});
const scratch = Effect.fn("StartupCompletion.scratch")(function* (request: Scratch) {
  yield* applyScratchRoutes(request);
  return yield* waitForServiceReadiness(request);
});

export function completeStartup(request: UserStart): ReturnType<typeof userStart>;
export function completeStartup(request: Selected): ReturnType<typeof selected>;
export function completeStartup(request: EnsureGlobal): ReturnType<typeof waitForServiceReadiness>;
export function completeStartup(request: Scratch): ReturnType<typeof scratch>;
export function completeStartup<E>(request: GlobalGroups<E>): ReturnType<typeof completeGlobalGroups<E>>;
export function completeStartup<E>(request: UserStart | Selected | EnsureGlobal | Scratch | GlobalGroups<E>) {
  switch (request.policy) {
    case "user-start":
      return userStart(request);
    case "selected":
      return selected(request);
    case "ensure-global":
      return waitForServiceReadiness(request);
    case "scratch":
      return scratch(request);
    case "global-groups":
      return completeGlobalGroups(request);
    default:
      return request satisfies never;
  }
}
