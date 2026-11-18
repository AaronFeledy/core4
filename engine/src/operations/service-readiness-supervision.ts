import { restartVerdict } from "@lando/container-runtime/supervision";
import type { HealthcheckTargetUnsupportedError, ServiceNotReadyError } from "@lando/sdk/errors";
import { MessageWarnEvent } from "@lando/sdk/events";
import { EventService, type ServiceRuntimeInfo } from "@lando/sdk/services";
import { DateTime, Deferred, Effect, Option } from "effect";
import { commandWarningsUseMachineOutput, recordCommandWarning } from "../landofile/command-warnings.ts";
import type { ObservedService } from "./connection-collector.ts";
import { reconcileReadinessState } from "./connection-state.ts";
import {
  type ReadinessTarget,
  failReadinessIncarnation,
  inspectReadinessRuntime,
  inspectServiceRunning,
  isSupervisedTarget,
  readinessCommands,
  readinessFailureRuntime,
  redactorForReadiness,
  sameReadinessIncarnation,
} from "./service-readiness-error.ts";

const inspectSameIncarnation = (target: ReadinessTarget, initial: ServiceRuntimeInfo) =>
  inspectReadinessRuntime(target).pipe(
    Effect.flatMap((runtime) =>
      sameReadinessIncarnation(initial, runtime)
        ? Effect.succeed(runtime)
        : failReadinessIncarnation(target, runtime),
    ),
  );

type ReadinessRow = ObservedService & { readonly initial: ServiceRuntimeInfo };
interface SupervisedActor {
  readonly target: ReadinessTarget;
  readonly initial: ServiceRuntimeInfo;
  readonly signal: Deferred.Deferred<ReadinessRow, ServiceNotReadyError>;
  publishing: boolean;
  row: ReadinessRow | undefined;
}

const warnRestarting = Effect.fn("ServiceReadiness.warnRestarting")(function* (
  error: ServiceNotReadyError,
  target: ReadinessTarget,
) {
  const redactor = yield* redactorForReadiness;
  const remediation = readinessCommands(target).logs;
  const tail = redactor.redactString(error.logTail?.lines.slice(-5).join("\n") ?? "").slice(-600);
  const message = redactor.redactString(
    `Supervised service ${error.service} is restarting (${error.reason})${error.exitCode === undefined ? "" : `; exit code ${error.exitCode}`}.${error.lastStatus === undefined ? "" : ` ${error.lastStatus}`}${tail.length === 0 ? "" : `\n${tail}`}\nRun \`${remediation}\`.`,
  );
  yield* recordCommandWarning({
    code: "LANDO_SERVICE_RESTARTING",
    message,
    remediation,
    context: {
      service: error.service,
      reason: error.reason,
      ...(error.exitCode === undefined ? {} : { exitCode: String(error.exitCode) }),
      ...(tail.length === 0 ? {} : { logTail: tail }),
    },
  });
  if (yield* commandWarningsUseMachineOutput) return;
  const events = yield* Effect.serviceOption(EventService);
  if (Option.isSome(events))
    yield* events.value
      .publish(MessageWarnEvent.make({ body: message, timestamp: yield* DateTime.now }))
      .pipe(Effect.catch(() => Effect.void));
});

export const makeServiceSupervision = Effect.fnUntraced(function* (
  targets: ReadonlyArray<{ readonly target: ReadinessTarget; readonly initial: ServiceRuntimeInfo }>,
) {
  const entries = yield* Effect.forEach(
    targets.filter(({ target }) => isSupervisedTarget(target)),
    ({ target, initial }) =>
      Effect.map(
        Deferred.make<ReadinessRow, ServiceNotReadyError>(),
        (signal): SupervisedActor => ({ target, initial, signal, publishing: false, row: undefined }),
      ),
  );
  const actors = new Map(entries.map((actor) => [String(actor.target.service), actor]));
  const settle = Effect.fnUntraced(function* (error: ServiceNotReadyError) {
    if (error.reason !== "not-running") return yield* Effect.fail(error);
    const actor = actors.get(error.service);
    if (actor === undefined) return yield* Effect.fail(error);
    const failed = readinessFailureRuntime(error);
    if (failed === undefined || !sameReadinessIncarnation(actor.initial, failed))
      return yield* Effect.fail(error);
    if (failed.status !== "restarting" && !(failed.status === "exited" && failed.exitCode !== undefined))
      return yield* Effect.fail(error);
    const service = actor.target.plan.services[actor.target.service];
    if (service === undefined)
      return yield* Effect.die("Supervised readiness service is absent from its full plan.");
    if (
      restartVerdict({
        source: "planned",
        service,
        state: failed.status,
        exitCode: failed.exitCode,
      }) !== "expected"
    )
      return yield* Effect.fail(error);
    if (actor.row !== undefined) return actor.row;
    if (actor.publishing) return yield* Deferred.await(actor.signal);
    actor.publishing = true;
    const runtime = yield* inspectSameIncarnation(actor.target, actor.initial).pipe(
      Effect.tapError((error) => Deferred.fail(actor.signal, error)),
    );
    yield* warnRestarting(error, actor.target);
    const row: ReadinessRow = {
      name: String(service.name),
      state: "restarting",
      runtime,
      initial: actor.initial,
    };
    actor.row = row;
    yield* Deferred.succeed(actor.signal, row);
    return row;
  });
  const wait = <R>(
    name: string,
    effect: Effect.Effect<ReadinessRow, ServiceNotReadyError | HealthcheckTargetUnsupportedError, R>,
  ) => {
    const actor = actors.get(name);
    return actor === undefined
      ? effect
      : Effect.raceFirst(
          effect.pipe(Effect.catchTag("ServiceNotReadyError", settle)),
          Deferred.await(actor.signal),
        );
  };
  const observe = ({
    target,
    initial,
  }: {
    readonly target: ReadinessTarget;
    readonly initial: ServiceRuntimeInfo;
  }) =>
    Effect.suspend(() =>
      actors.get(String(target.service))?.row !== undefined
        ? Effect.void
        : inspectServiceRunning(target, initial).pipe(
            Effect.asVoid,
            Effect.catchTag("ServiceNotReadyError", (error) => settle(error).pipe(Effect.asVoid)),
          ),
    );
  const finish = (target: ReadinessTarget, row: ReadinessRow) =>
    (row.state === "restarting"
      ? inspectSameIncarnation(target, row.initial)
      : inspectServiceRunning(target, row.initial)
    ).pipe(
      Effect.map((runtime) => ({ ...row, runtime, state: reconcileReadinessState(row.state, runtime) })),
      Effect.catchTag("ServiceNotReadyError", (error) =>
        row.state === "restarting" ? Effect.fail(error) : settle(error),
      ),
    );
  return { wait, observe, finish };
});
