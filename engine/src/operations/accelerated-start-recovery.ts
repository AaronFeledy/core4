import { sameRealpath } from "@lando/paths";
import { FileSyncStartError } from "@lando/sdk/errors";
import type { AppPlan, AppRef, PreparedFileSyncTarget } from "@lando/sdk/schema";
import { FileSyncEngine, type FileSyncEngineShape } from "@lando/sdk/services";
import { Cause, Effect, Exit, Option } from "effect";
import type { PendingStart } from "./accelerated-start-record.ts";

const recoveryError = (record: PendingStart, message: string) =>
  new FileSyncStartError({
    engineId: record.engineId,
    message,
    remediation:
      "Restore the recorded provider and file-sync engine, then run `lando start` in the app root, or `lando destroy` to discard the retained attempt. Unknown sessions must be inspected manually; they have been left untouched.",
  });

export const recordedSessionInventory = Effect.fnUntraced(function* (app: AppRef, record: PendingStart) {
  const selected = yield* Effect.serviceOption(FileSyncEngine);
  if (Option.isNone(selected) || selected.value.id !== record.engineId) {
    return yield* Effect.fail(
      recoveryError(record, "Automatic recovery requires the recorded file-sync engine."),
    );
  }
  const engine = selected.value;
  const sessions = yield* engine.listSessions({ app });
  if (
    sessions.some(
      ({ spec, app: observedApp, service, mountKey }) =>
        observedApp.kind !== app.kind ||
        observedApp.id !== app.id ||
        !sameRealpath(observedApp.root, app.root) ||
        service !== spec.service ||
        mountKey !== spec.mountKey ||
        spec.app.kind !== app.kind ||
        spec.app.id !== app.id ||
        !sameRealpath(spec.app.root, app.root) ||
        !record.sessions.some(({ name }) => name === `${spec.service}/${spec.mountKey}`),
    )
  ) {
    return yield* Effect.fail(
      recoveryError(
        record,
        "Unknown file-sync sessions exist for this app; automatic recovery is not possible.",
      ),
    );
  }
  return { engine, sessions };
});

export const terminateRetainedSessions = Effect.fnUntraced(function* (app: AppRef, record: PendingStart) {
  const { engine, sessions } = yield* recordedSessionInventory(app, record);
  yield* Effect.forEach(sessions, ({ ref }) => engine.terminateSession(ref), { discard: true });
});

export const reseedRetainedTargets = Effect.fnUntraced(function* (
  plan: AppPlan,
  recovery: { readonly record: PendingStart; readonly targets: readonly PreparedFileSyncTarget[] },
  engine: FileSyncEngineShape,
) {
  const { record, targets } = recovery;
  if (!engine.capabilities.modes.includes("one-way-replica")) {
    return yield* Effect.fail(
      recoveryError(
        record,
        "Automatic recovery requires one-way-replica support; the selected engine cannot reseed safely.",
      ),
    );
  }
  if (
    targets.length !== record.targets.length ||
    targets.some(
      ({ session, endpoint }) =>
        !record.targets.some(
          (target) =>
            target.service === session.service &&
            target.mountKey === session.mountKey &&
            target.volumeName === endpoint.volumeName,
        ),
    )
  ) {
    return yield* Effect.fail(
      recoveryError(record, "Prepared volume names differ from the retained journal."),
    );
  }
  for (const { session } of plan.fileSync) {
    yield* Effect.scoped(
      Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const ref = yield* engine.createSession({ ...session, mode: "one-way-replica" });
          const flushed = yield* Effect.exit(restore(engine.flushSession(ref)));
          const terminated = yield* Effect.exit(engine.terminateSession(ref));
          if (Exit.isFailure(flushed))
            return yield* Effect.failCause(
              Exit.isFailure(terminated) ? Cause.combine(flushed.cause, terminated.cause) : flushed.cause,
            );
          if (Exit.isFailure(terminated)) return yield* Effect.failCause(terminated.cause);
        }),
      ),
    );
  }
});
