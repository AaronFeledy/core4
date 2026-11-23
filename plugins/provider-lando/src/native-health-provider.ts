import type { EngineHttpApi } from "@lando/container-runtime/engine-api";
import { ProviderUnavailableError } from "@lando/sdk/errors";
import { MessageWarnEvent } from "@lando/sdk/events";
import type { PluginStateStore } from "@lando/sdk/plugins";
import type { Redactor } from "@lando/sdk/secrets";
import type { EventService, ProcessRunner, RuntimeProviderShape } from "@lando/sdk/services";
import { storeErrorRemediation } from "@lando/state-store";
import { type Context, DateTime, Effect } from "effect";

import { type DelegatedScopeHost, type UserSystemdTools, processScopeUnit } from "./delegated-scope.ts";
import { readRuntimePid } from "./linux-runtime-reaper.ts";
import { makeNativeHealthTimers, processUserSystemd } from "./native-health-timers.ts";

type NativeHealthTimers = ReturnType<typeof makeNativeHealthTimers>;

/**
 * The one lock enrollment, reconcile and teardown removal share, so a sweep never races a create.
 * Teardown waits `brief`: it must not hang a poweroff behind another command's lifecycle operation.
 */
export const nativeHealthLock =
  (stateStore: PluginStateStore | undefined, wait: "brief" | "operation" = "operation") =>
  <A, E>(body: Effect.Effect<A, E>): Effect.Effect<A, E | ProviderUnavailableError> =>
    stateStore === undefined
      ? body
      : stateStore
          .withLock("native-health-timers", body, {
            wait,
            resource: "Lando native healthcheck timers",
          })
          .pipe(
            Effect.catchTag("StateStoreError", (cause) =>
              Effect.fail(
                new ProviderUnavailableError({
                  providerId: "lando",
                  operation: "nativeHealth",
                  message: "Could not lock Lando's native healthcheck timers.",
                  remediation: storeErrorRemediation(
                    cause,
                    "Wait for the other Lando command to finish, then retry.",
                  ),
                  cause,
                }),
              ),
            ),
          );

export interface ManagedNativeHealthInput {
  readonly tools: UserSystemdTools;
  readonly processRunner: Context.Service.Shape<typeof ProcessRunner>;
  readonly api: EngineHttpApi;
  readonly host: DelegatedScopeHost;
  readonly pidPath: string;
  readonly prefix: string;
  readonly runtimeBinDir: string;
  readonly socketPath: string;
  readonly runtimeConfigDir: string;
  readonly dataRoot: string | undefined;
  readonly stateStore: PluginStateStore | undefined;
  readonly eventService: Pick<Context.Service.Shape<typeof EventService>, "publish"> | undefined;
  readonly redactor: Redactor;
}

/** Native health scheduling for the managed Linux runtime, bound to its host and stores. */
export const makeManagedNativeHealth = (input: ManagedNativeHealthInput): NativeHealthTimers =>
  makeNativeHealthTimers({
    systemd: processUserSystemd(input.processRunner, input.tools.userRuntimeDir),
    tools: input.tools,
    api: input.api,
    prefix: input.prefix,
    runtimeBinDir: input.runtimeBinDir,
    socketPath: input.socketPath,
    runtimeConfigDir: input.runtimeConfigDir,
    dataRoot: input.dataRoot,
    scope: readRuntimePid(input.pidPath).pipe(
      Effect.map((pid) => (pid === undefined ? undefined : processScopeUnit(pid, input.host))),
    ),
    withLock: nativeHealthLock(input.stateStore),
    warn: (error) => {
      const events = input.eventService;
      if (events === undefined) return Effect.void;
      return DateTime.now.pipe(
        Effect.flatMap((timestamp) =>
          events.publish(
            MessageWarnEvent.make({
              body: input.redactor.redactString(`${error.message} ${error.remediation}`),
              timestamp,
            }),
          ),
        ),
        Effect.catch(() => Effect.void),
      );
    },
  });

const reconcilingAfter =
  <Args extends ReadonlyArray<unknown>, A, E, R>(
    operation: (...args: Args) => Effect.Effect<A, E, R>,
    reconcile: Effect.Effect<void>,
  ) =>
  (...args: Args): Effect.Effect<A, E, R> =>
    operation(...args).pipe(Effect.tap(() => reconcile));

/**
 * Repairs and sweeps health timers after every successful container lifecycle operation; a failed
 * operation is reconciled by the next one that succeeds. Never on run, exec, info or logs.
 */
export const withNativeHealthReconcile = <P extends RuntimeProviderShape>(
  provider: P,
  reconcile: Effect.Effect<void>,
): P => ({
  ...provider,
  apply: reconcilingAfter(provider.apply, reconcile),
  start: reconcilingAfter(provider.start, reconcile),
  restart: reconcilingAfter(provider.restart, reconcile),
  stop: reconcilingAfter(provider.stop, reconcile),
  destroy: reconcilingAfter(provider.destroy, reconcile),
  ...(provider.resume === undefined ? {} : { resume: reconcilingAfter(provider.resume, reconcile) }),
  ...(provider.suspend === undefined ? {} : { suspend: reconcilingAfter(provider.suspend, reconcile) }),
  ...(provider.removeObservedService === undefined
    ? {}
    : { removeObservedService: reconcilingAfter(provider.removeObservedService, reconcile) }),
  ...(provider.quiesceForFileSync === undefined
    ? {}
    : { quiesceForFileSync: reconcilingAfter(provider.quiesceForFileSync, reconcile) }),
});
