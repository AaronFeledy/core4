import type { RedactionService } from "@lando/redaction/service";
import type {
  RestartAppOptions,
  RestartAppResult,
  RestartAppError as SdkRestartAppError,
} from "@lando/sdk/app";
import type { ComposeKeyRejectedError, LandofileLoadExpressionError } from "@lando/sdk/errors";
import { PostRestartEvent, PreRestartEvent } from "@lando/sdk/events";
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
import { publishStartWarnings } from "./start-warnings.ts";
import { publishPlacementVolumeTransitionNotices } from "./volume-transition-notice.ts";

export type RestartAppError = SdkRestartAppError | ComposeKeyRejectedError | LandofileLoadExpressionError;
export type { RestartAppOptions, RestartAppResult } from "@lando/sdk/app";

type RestartAppServices =
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

export const restartApp = Effect.fn("AppOperation.restart")(
  function* (
    options: RestartAppOptions = {},
    target?: ResolvedAppTarget,
    managed?: StartManagedScope,
  ): Effect.fn.Return<RestartAppResult, RestartAppError, RestartAppServices> {
    if (options.signal?.aborted === true) return yield* Effect.interrupt;
    const initialTarget = target ?? (yield* resolveDesiredAppTarget);
    return yield* withAppActivation(
      {
        operation: "restart",
        target: initialTarget,
        services: options.services,
        signal: options.signal,
        noSnapshot: options.noSnapshot,
        managed,
      },
      Effect.fnUntraced(function* (admitted) {
        const { target: resolvedTarget, placement, removedByResume } = admitted;
        const plan = resolvedTarget.plan;
        const selectedPlan = admitted.scope === "services" ? admitted.selectedPlan : plan;
        const selected =
          admitted.scope === "services"
            ? Object.values(selectedPlan.services).map((service) => service.name)
            : undefined;
        const preRestart = PreRestartEvent.make({
          _tag: "pre-restart",
          scope: "app",
          app: resolvedTarget.app,
          plan,
          triggeredBy: "app:restart",
          timestamp: DateTime.nowUnsafe(),
          ...(selected === undefined ? {} : { services: [...selected] }),
        });
        // A whole relaunch announces its launch again; the publisher skips the repeats.
        yield* publishStartWarnings(selectedPlan);
        yield* publishAndRunAppEvent(plan, "pre-restart", preRestart);
        yield* publishPlacementVolumeTransitionNotices(placement, selectedPlan);
        const result: RestartAppResult =
          admitted.scope === "services"
            ? {
                app: plan.name,
                ...(yield* relaunchSelectedServices(admitted, {
                  operation: "restart",
                  ...(options.signal === undefined ? {} : { signal: options.signal }),
                  ...(managed === undefined ? {} : { managed }),
                })),
                ...(removedByResume.length === 0 ? {} : { servicesRemoved: removedByResume }),
              }
            : yield* haltAndRelaunchApp(
                admitted,
                {
                  reconcile: options.reconcile ?? false,
                  ...(options.signal === undefined ? {} : { signal: options.signal }),
                },
                managed,
                { announceApplyOutcome: true },
              );
        const postRestart = PostRestartEvent.make({
          _tag: "post-restart",
          scope: "app",
          app: resolvedTarget.app,
          plan,
          timestamp: DateTime.nowUnsafe(),
          ...(selected === undefined ? {} : { services: [...selected] }),
        });
        yield* publishAndRunAppEvent(plan, "post-restart", postRestart);
        return {
          ...result,
          ...(admitted.dataVersionChanges === undefined
            ? {}
            : { dataVersionChanges: admitted.dataVersionChanges }),
        };
      }),
    );
  },
  (effect, options: RestartAppOptions = {}, _target?: ResolvedAppTarget, _managed?: StartManagedScope) => {
    const signal = options.signal;
    if (signal === undefined) return effect;
    return Effect.raceFirst(
      effect,
      Effect.callback<never>((resume) => {
        const abort = () => resume(Effect.interrupt);
        if (signal.aborted) {
          abort();
          return;
        }
        signal.addEventListener("abort", abort, { once: true });
        return Effect.sync(() => signal.removeEventListener("abort", abort));
      }),
    );
  },
);
