import type { AppPlan, RouterConfig, ServicePlan } from "@lando/sdk/schema";
import type { BuildOrchestrator, RouterServiceShape } from "@lando/sdk/services";
import type { ProgressEmitter } from "@lando/sdk/task-progress";
import { Effect } from "effect";
import { waitForServiceReadiness } from "../operations/service-readiness.ts";
import { startFileSyncSessions } from "../operations/start-file-sync.ts";
import { withRoutesStartProgress } from "../operations/start-progress-phases.ts";
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
type SelectedRestart = Readiness & {
  readonly policy: "selected-restart";
  readonly selectedPlan: AppPlan;
  readonly events: ProgressEmitter;
};
type SelectedRebuild = Readiness & {
  readonly policy: "selected-rebuild";
  readonly selectedPlan: AppPlan;
  readonly builds: typeof BuildOrchestrator.Service;
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
    request.builds.buildApp(request.plan, {
      ...(request.forceAppBuild === true ? { force: true } : {}),
      ...(request.signal === undefined ? {} : { signal: request.signal }),
    }),
    request.provider,
  );
  const routes = applyAppRoutes(request.router, request.plan, request.landofileRouter);
  yield* request.plan.routes.length === 0
    ? routes
    : withRoutesStartProgress({ events: request.events, plan: request.plan, work: routes });
  return yield* waitForServiceReadiness(request);
});
const selectedRestart = Effect.fn("StartupCompletion.selectedRestart")(function* (request: SelectedRestart) {
  yield* startFileSyncSessions(request.selectedPlan, request.events);
  return yield* waitForServiceReadiness(request);
});
const selectedRebuild = Effect.fn("StartupCompletion.selectedRebuild")(function* (request: SelectedRebuild) {
  yield* withBuildProvider(
    request.builds.buildApp(request.selectedPlan, {
      force: true,
      ...(request.signal === undefined ? {} : { signal: request.signal }),
    }),
    request.provider,
  );
  return yield* waitForServiceReadiness(request);
});
const scratch = Effect.fn("StartupCompletion.scratch")(function* (request: Scratch) {
  yield* applyScratchRoutes(request);
  return yield* waitForServiceReadiness(request);
});

export function completeStartup(request: UserStart): ReturnType<typeof userStart>;
export function completeStartup(request: SelectedRestart): ReturnType<typeof selectedRestart>;
export function completeStartup(request: SelectedRebuild): ReturnType<typeof selectedRebuild>;
export function completeStartup(request: EnsureGlobal): ReturnType<typeof waitForServiceReadiness>;
export function completeStartup(request: Scratch): ReturnType<typeof scratch>;
export function completeStartup<E>(request: GlobalGroups<E>): ReturnType<typeof completeGlobalGroups<E>>;
export function completeStartup<E>(
  request: UserStart | SelectedRestart | SelectedRebuild | EnsureGlobal | Scratch | GlobalGroups<E>,
) {
  switch (request.policy) {
    case "user-start":
      return userStart(request);
    case "selected-restart":
      return selectedRestart(request);
    case "selected-rebuild":
      return selectedRebuild(request);
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
