import { DateTime, Effect } from "effect";

import { SqlConfirmRequiredError } from "@lando/sdk/errors";
import {
  TaskCompleteEvent,
  TaskStartEvent,
  TaskTreeCompleteEvent,
  TaskTreeStartEvent,
} from "@lando/sdk/events";

import type { DbCommandStep } from "./schemas.ts";

export type SqlPublisher = (event: {
  readonly _tag: string;
  readonly [key: string]: unknown;
}) => Effect.Effect<void, unknown>;

export const confirmOrFail = (
  input: { readonly yes: boolean },
  confirm: (message: string) => Effect.Effect<boolean, unknown>,
  service: string,
  steps: ReadonlyArray<DbCommandStep>,
  message: string,
) => {
  if (input.yes) return Effect.void;
  return confirm(message).pipe(
    Effect.catchAll(() => Effect.succeed(false)),
    Effect.flatMap((accepted) =>
      accepted
        ? Effect.void
        : Effect.fail(
            new SqlConfirmRequiredError({
              message,
              service,
              steps,
              remediation: "Re-run with --yes after reviewing the listed steps.",
            }),
          ),
    ),
  );
};

export type SqlProgressHandle = {
  readonly complete: Effect.Effect<void, unknown>;
};

export const publishTree = (
  publish: SqlPublisher,
  label: string,
  steps: ReadonlyArray<DbCommandStep>,
): Effect.Effect<SqlProgressHandle, unknown> =>
  Effect.gen(function* () {
    const startedAt = Date.now();
    const now = DateTime.unsafeNow();
    yield* publish(
      TaskTreeStartEvent.make({
        parentId: "db",
        label,
        children: steps.map((step) => step.id),
        timestamp: now,
      }),
    );
    for (const step of steps) {
      yield* publish(
        TaskStartEvent.make({ taskId: step.id, parentId: "db", label: step.label, timestamp: now }),
      );
    }
    return {
      complete: completeTree(publish, steps, startedAt),
    };
  });

export const completeTree = (
  publish: SqlPublisher,
  steps: ReadonlyArray<DbCommandStep>,
  startedAt?: number,
) =>
  Effect.gen(function* () {
    const now = DateTime.unsafeNow();
    const durationMs = startedAt === undefined ? 0 : Math.max(0, Date.now() - startedAt);
    for (const step of steps) {
      yield* publish(TaskCompleteEvent.make({ taskId: step.id, durationMs, timestamp: now }));
    }
    yield* publish(
      TaskTreeCompleteEvent.make({
        parentId: "db",
        succeeded: steps.length,
        failed: 0,
        durationMs,
        timestamp: now,
      }),
    );
  });
