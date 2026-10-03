import { Clock, DateTime, Effect } from "effect";

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
    Effect.catch(() => Effect.succeed(false)),
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

export const publishTree = Effect.fnUntraced(function* (
  publish: SqlPublisher,
  label: string,
  steps: ReadonlyArray<DbCommandStep>,
): Effect.fn.Return<SqlProgressHandle, unknown> {
  const startedAt = yield* Clock.currentTimeMillis;
  const now = yield* DateTime.now;
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

export const completeTree = Effect.fnUntraced(function* (
  publish: SqlPublisher,
  steps: ReadonlyArray<DbCommandStep>,
  startedAt?: number,
) {
  const now = yield* DateTime.now;
  const durationMs = startedAt === undefined ? 0 : Math.max(0, (yield* Clock.currentTimeMillis) - startedAt);
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
