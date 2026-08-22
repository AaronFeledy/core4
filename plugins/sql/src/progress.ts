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

export const publishTree = (publish: SqlPublisher, label: string, steps: ReadonlyArray<DbCommandStep>) =>
  Effect.gen(function* () {
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
  });

export const completeTree = (publish: SqlPublisher, steps: ReadonlyArray<DbCommandStep>) =>
  Effect.gen(function* () {
    const now = DateTime.unsafeNow();
    for (const step of steps) {
      yield* publish(TaskCompleteEvent.make({ taskId: step.id, timestamp: now }));
    }
    yield* publish(
      TaskTreeCompleteEvent.make({ parentId: "db", succeeded: steps.length, failed: 0, timestamp: now }),
    );
  });
