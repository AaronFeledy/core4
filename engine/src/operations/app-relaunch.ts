import type { StartAppOptions } from "@lando/sdk/app";
import { type BuildOptions, StateStore } from "@lando/sdk/services";
import { Effect } from "effect";
import { withLaunchVolumeCoordination } from "../lifecycle/volume-coordination.ts";
import { prepareProvider } from "../providers/prepared.ts";
import type { AdmittedApp } from "./app-activation.ts";
import { mergeRemovedServices } from "./start-convergence.ts";
import type { StartManagedScope } from "./start-file-sync.ts";
import { rotateChangedFileSync } from "./start-file-sync-rotation.ts";
import { markStartMutation } from "./start-incomplete-notice.ts";
import { launchAdmittedApp, preflightStartAppDrain } from "./start-internal.ts";
import { haltAppRuntime } from "./stop.ts";

/**
 * The whole-app cycle restart and rebuild share: halt the admitted app, then launch it again.
 *
 * The halt stops containers and keeps them along with applied state, so admission still holds.
 * The relaunch repeats only what the halt and its `post-stop` hook can change: the runtime may have
 * gone away, file sync may need rotation, a volume may have changed owner, and the halt recorded a
 * drain. The relaunch's whole-app convergence removes services the Landofile no longer defines.
 */
export const haltAndRelaunchApp = Effect.fn("AppOperation.haltAndRelaunch")(function* (
  admitted: AdmittedApp,
  options: StartAppOptions,
  managed: StartManagedScope | undefined,
  execution: {
    readonly buildOptions?: BuildOptions;
    readonly forceAppBuild?: boolean;
    readonly announceApplyOutcome?: boolean;
  } = {},
) {
  const { target } = admitted;
  const plan = target.plan;
  const stateStore = yield* StateStore;

  yield* markStartMutation(plan);
  yield* haltAppRuntime(target);
  yield* managed?.onStopped ?? Effect.void;

  const provider = yield* prepareProvider(admitted.provider);
  yield* rotateChangedFileSync(target, provider);
  const result = yield* withLaunchVolumeCoordination({
    plan,
    provider,
    stateStore,
    body: Effect.fnUntraced(function* () {
      const preparedTargets = yield* preflightStartAppDrain(target);
      return yield* launchAdmittedApp(admitted, options, managed, {
        ...execution,
        ...(preparedTargets === undefined ? {} : { preparedTargets }),
      });
    }),
  });
  return {
    ...result,
    servicesRemoved: mergeRemovedServices(admitted.removedByResume, result.servicesRemoved),
  };
});
