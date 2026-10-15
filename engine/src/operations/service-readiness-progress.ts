import { ServiceNotReadyError } from "@lando/sdk/errors";
import type { AppPlan, ServiceName } from "@lando/sdk/schema";
import { EventService } from "@lando/sdk/services";
import {
  publishTaskComplete,
  publishTaskFail,
  publishTaskStart,
  publishTreeComplete,
  publishTreeStart,
  startChildTaskId,
} from "@lando/sdk/task-progress";
import { Cause, Clock, Effect, Exit, Option, Semaphore } from "effect";
import { startReadinessTreeId } from "./start-progress.ts";

export const makeReadinessProgress = Effect.fnUntraced(function* (
  plan: Pick<AppPlan, "id" | "name">,
  services: ReadonlyArray<ServiceName>,
) {
  const selected = yield* Effect.serviceOption(EventService);
  const events = Option.isSome(selected) ? selected.value : undefined;
  const mutex = yield* Semaphore.make(1);
  const parentId = startReadinessTreeId(String(plan.id));
  const waiting = new Set(services.map(String));
  const visible = new Set<string>();
  const succeeded = new Set<string>();
  let opened = false;
  let hasRestarting = false;
  let openedAt = 0;
  const startRow = (name: string) =>
    publishTaskStart(events, {
      parentId,
      taskId: startChildTaskId(parentId, name),
      label: `Wait for ${name}`,
    });
  const show = Effect.sleep("100 millis").pipe(
    Effect.andThen(
      mutex.withPermits(1)(
        Effect.gen(function* () {
          if (events === undefined || waiting.size === 0) return;
          for (const name of waiting) visible.add(name);
          openedAt = yield* Clock.currentTimeMillis;
          opened = true;
          yield* publishTreeStart(events, {
            parentId,
            label: `Readiness ${plan.name}`,
            children: [...visible].map((name) => startChildTaskId(parentId, name)),
            mode: "list",
          });
          for (const name of visible) yield* startRow(name);
        }),
      ),
    ),
  );
  const complete = (row: { readonly name: string; readonly state: string }) =>
    mutex.withPermits(1)(
      Effect.gen(function* () {
        hasRestarting ||= row.state === "restarting";
        waiting.delete(row.name);
        if (!opened || !visible.has(row.name)) return;
        succeeded.add(row.name);
        yield* publishTaskComplete(events, {
          taskId: startChildTaskId(parentId, row.name),
          summary: `${row.name} (${row.state})`,
          ...(row.state === "restarting" ? { outcome: "warn" as const } : {}),
        });
      }),
    );
  const finish = (exit: Exit.Exit<unknown, unknown>) =>
    mutex.withPermits(1)(
      Effect.gen(function* () {
        if (!opened) return;
        let failed = 0;
        let summary = hasRestarting
          ? `${plan.name} checked; supervised services restarting`
          : `${plan.name} ready`;
        if (Exit.isFailure(exit)) {
          const primary = Cause.findErrorOption(exit.cause);
          const error =
            Option.isSome(primary) && primary.value instanceof ServiceNotReadyError
              ? primary.value
              : undefined;
          if (error !== undefined) summary = `${error.service}: ${error.reason}`;
          else if (Cause.hasInterruptsOnly(exit.cause))
            summary = `${plan.name} readiness interrupted; applied app retained`;
          else summary = `${plan.name} readiness failed`;
          if (error !== undefined) {
            if (!visible.has(error.service)) {
              visible.add(error.service);
              yield* startRow(error.service);
            }
            succeeded.delete(error.service);
            yield* publishTaskFail(events, {
              taskId: startChildTaskId(parentId, error.service),
              summary: `${error.service}: ${error.reason}`,
              remediation: error.remediation,
              ...(error.exitCode === undefined ? {} : { exitCode: error.exitCode }),
            });
            failed++;
          }
          for (const name of visible) {
            if (succeeded.has(name) || name === error?.service) continue;
            yield* publishTaskFail(events, {
              taskId: startChildTaskId(parentId, name),
              summary: `${name}: ${summary}`,
            });
            failed++;
          }
        }
        yield* publishTreeComplete(events, {
          parentId,
          succeeded: succeeded.size,
          failed,
          summary,
          durationMs: (yield* Clock.currentTimeMillis) - openedAt,
        });
      }),
    );
  return { show, complete, finish };
});
