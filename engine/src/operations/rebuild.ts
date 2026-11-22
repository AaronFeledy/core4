import type { RedactionService } from "@lando/redaction/service";

import type {
  RebuildAppOptions,
  RebuildAppResult,
  RebuildAppError as SdkRebuildAppError,
  StartAppResult,
} from "@lando/sdk/app";
import type { ComposeKeyRejectedError, LandofileLoadExpressionError } from "@lando/sdk/errors";
import { PostRebuildEvent, PreRebuildEvent } from "@lando/sdk/events";
import type {
  AppPlanner,
  BuildOrchestrator,
  EnvironmentValueResolver,
  EventService,
  FileSystem,
  GlobalAppService,
  LandofileService,
  ManagedFileTransactionGuard,
  PathsService,
  PluginRegistry,
  RouterService,
  RuntimeProviderRegistry,
  ShellRunner,
  StateStore,
} from "@lando/sdk/services";
import type { PrivateFileAccessService } from "@lando/state-store/private-file-access";
import { DateTime, Effect } from "effect";
import { type ResolvedAppTarget, resolveDesiredAppTarget } from "../landofile/app-resolution.ts";
import { withAppActivation } from "./app-activation.ts";
import { haltAndRelaunchApp } from "./app-relaunch.ts";
import { publishAndRunAppEvent } from "./events.ts";
import { relaunchSelectedServices } from "./selected-relaunch.ts";
import type { StartManagedScope } from "./start-file-sync.ts";
import { publishPlacementVolumeTransitionNotices } from "./volume-transition-notice.ts";

export type RebuildAppError = SdkRebuildAppError | ComposeKeyRejectedError | LandofileLoadExpressionError;
export type { RebuildAppOptions, RebuildAppResult } from "@lando/sdk/app";

type RebuildAppServices =
  | EnvironmentValueResolver
  | AppPlanner
  | BuildOrchestrator
  | EventService
  | FileSystem
  | GlobalAppService
  | LandofileService
  | ManagedFileTransactionGuard
  | PathsService
  | PrivateFileAccessService
  | PluginRegistry
  | RouterService
  | RedactionService
  | RuntimeProviderRegistry
  | ShellRunner
  | StateStore;

export const rebuildApp = Effect.fn("AppOperation.rebuild")(function* (
  options: RebuildAppOptions = {},
  target?: ResolvedAppTarget,
  managed?: StartManagedScope,
): Effect.fn.Return<RebuildAppResult, RebuildAppError, RebuildAppServices> {
  const initialTarget = target ?? (yield* resolveDesiredAppTarget);
  return yield* withAppActivation(
    {
      operation: "rebuild",
      target: initialTarget,
      services: options.services,
      signal: options.signal,
      managed,
    },
    Effect.fnUntraced(function* (admitted) {
      const { target: resolvedTarget, placement, removedByResume } = admitted;
      const plan = resolvedTarget.plan;
      const selectedPlan = admitted.scope === "services" ? admitted.selectedPlan : plan;
      const ref = resolvedTarget.app;
      const preRebuild = PreRebuildEvent.make({
        _tag: "pre-rebuild",
        app: ref,
        timestamp: DateTime.nowUnsafe(),
      });
      yield* publishAndRunAppEvent(plan, "pre-rebuild", preRebuild);
      yield* publishPlacementVolumeTransitionNotices(placement, selectedPlan);
      const start: StartAppResult =
        admitted.scope === "services"
          ? {
              app: plan.name,
              ...(yield* relaunchSelectedServices(admitted, {
                operation: "rebuild",
                ...(options.signal === undefined ? {} : { signal: options.signal }),
                ...(managed === undefined ? {} : { managed }),
              })),
              ...(removedByResume.length === 0 ? {} : { servicesRemoved: removedByResume }),
            }
          : yield* haltAndRelaunchApp(
              admitted,
              {
                reconcile: true,
                ...(options.signal === undefined ? {} : { signal: options.signal }),
              },
              managed,
              { buildOptions: { refresh: true }, forceAppBuild: true },
            );
      const postRebuild = PostRebuildEvent.make({
        _tag: "post-rebuild",
        app: ref,
        timestamp: DateTime.nowUnsafe(),
      });
      yield* publishAndRunAppEvent(plan, "post-rebuild", postRebuild);
      return {
        app: start.app,
        servicesRebuilt: start.servicesStarted.map((service) => service.name),
        servicesStarted: start.servicesStarted,
        ...(start.credentialChanges === undefined ? {} : { credentialChanges: start.credentialChanges }),
        ...(start.checks === undefined ? {} : { checks: start.checks }),
        ...(start.servicesRemoved === undefined ? {} : { servicesRemoved: start.servicesRemoved }),
      };
    }),
  );
});
