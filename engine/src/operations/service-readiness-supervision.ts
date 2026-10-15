import { isServiceRestartExpected } from "@lando/container-runtime/supervision";
import type { ServiceNotReadyError } from "@lando/sdk/errors";
import { MessageWarnEvent } from "@lando/sdk/events";
import { EventService, type ServiceRuntimeInfo } from "@lando/sdk/services";
import { DateTime, Deferred, Effect, Option } from "effect";
import { commandWarningsUseMachineOutput, recordCommandWarning } from "../landofile/command-warnings.ts";
import { startedServiceRow } from "./authority-url.ts";
import {
  type ReadinessTarget,
  inspectServiceRunning,
  isSupervisedTarget,
  readinessCommands,
  redactorForReadiness,
} from "./service-readiness-error.ts";

type ReadinessRow = ReturnType<typeof startedServiceRow> & { readonly initial: ServiceRuntimeInfo };
interface SupervisedActor {
  readonly target: ReadinessTarget;
  readonly initial: ServiceRuntimeInfo;
  readonly signal: Deferred.Deferred<ReadinessRow>;
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
        Deferred.make<ReadinessRow>(),
        (signal): SupervisedActor => ({ target, initial, signal, publishing: false, row: undefined }),
      ),
  );
  const actors = new Map(entries.map((actor) => [String(actor.target.service), actor]));
  const settle = Effect.fnUntraced(function* (error: ServiceNotReadyError) {
    if (error.reason !== "not-running") return yield* Effect.fail(error);
    const actor = actors.get(error.service);
    if (actor === undefined) return yield* Effect.fail(error);
    if (error.exitCode === undefined && error.state !== "running" && error.state !== "restarting")
      return yield* Effect.fail(error);
    const service = actor.target.plan.services[actor.target.service];
    if (service === undefined)
      return yield* Effect.die("Supervised readiness service is absent from its full plan.");
    if (!isServiceRestartExpected(service, error.exitCode)) return yield* Effect.fail(error);
    if (actor.row !== undefined) return actor.row;
    if (actor.publishing) return yield* Deferred.await(actor.signal);
    actor.publishing = true;
    yield* warnRestarting(error, actor.target);
    const row = { ...startedServiceRow(service, actor.initial), state: "restarting", initial: actor.initial };
    actor.row = row;
    yield* Deferred.succeed(actor.signal, row);
    return row;
  });
  const wait = <R>(name: string, effect: Effect.Effect<ReadinessRow, ServiceNotReadyError, R>) => {
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
  }: { readonly target: ReadinessTarget; readonly initial: ServiceRuntimeInfo }) =>
    Effect.suspend(() =>
      actors.get(String(target.service))?.row !== undefined
        ? Effect.void
        : inspectServiceRunning(target, initial).pipe(
            Effect.asVoid,
            Effect.catchTag("ServiceNotReadyError", (error) => settle(error).pipe(Effect.asVoid)),
          ),
    );
  const finish = (target: ReadinessTarget, row: ReadinessRow) =>
    row.state === "restarting"
      ? Effect.succeed(row)
      : inspectServiceRunning(target, row.initial).pipe(
          Effect.as(row),
          Effect.catchTag("ServiceNotReadyError", settle),
        );
  return { wait, observe, finish };
});
