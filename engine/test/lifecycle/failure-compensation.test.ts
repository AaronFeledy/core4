import { expect, test } from "bun:test";
import {
  FailureRoleAnnotation,
  commandFailureCause,
  failureOutcomeFromCause,
} from "@lando/sdk/command-result";
import { Cause, Context, Effect, Exit, Schema } from "effect";
import {
  compensateFailure,
  mapFailureErrors,
  mergeFailure,
  runAllAndMergeFailures,
} from "../../src/lifecycle/failure-compensation.ts";

class OperationError extends Schema.TaggedError<OperationError>()("OperationError", {
  message: Schema.String,
}) {}
class OtherError extends Schema.TaggedError<OtherError>()("OtherError", {}) {}
const primary = new OperationError({ message: "operation" });
const secondary = new OperationError({ message: "rollback" });
const cause = mergeFailure(Cause.fail(primary), Cause.fail(secondary), "rollback");

test.each(["map", "catch-tag", "span", "round-trip", "nested-command"] as const)(
  "preserves failure identities and roles through %s",
  async (transform) => {
    const original: Effect.Effect<never, OperationError | OtherError> = Effect.failCause(cause);
    let work = original;
    switch (transform) {
      case "map":
        work = work.pipe(mapFailureErrors((error: OperationError | OtherError) => error));
        break;
      case "catch-tag":
        work = work.pipe(Effect.catchTag("OtherError", Effect.fail));
        break;
      case "span":
        work = Effect.fn("test.compensated")(function* () {
          return yield* original;
        })();
        break;
      case "round-trip":
        work = Effect.exit(work).pipe(
          Effect.flatMap((exit) =>
            Exit.isFailure(exit) ? Effect.failCause(exit.cause) : Effect.succeed(exit.value),
          ),
        );
        break;
      case "nested-command":
        work = Effect.failCause(
          Cause.map(commandFailureCause(cause), (error) => Schema.decodeUnknownSync(OperationError)(error)),
        );
        break;
      default:
        return transform satisfies never;
    }
    const exit = await Effect.runPromiseExit(work);
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit))
      expect(failureOutcomeFromCause(exit.cause)).toMatchObject({
        error: primary,
        additionalErrors: [{ role: "rollback", error: secondary }],
      });
  },
);

test("characterizes raw mapError dropping compound reasons rather than relying on it", () => {
  const exit = Effect.runSyncExit(Effect.failCause(cause).pipe(Effect.mapError((error) => error)));
  expect(Exit.isFailure(exit) && exit.cause.reasons.length).toBe(1);
});

test("preserves annotated cleanup in a scope finalizer", async () => {
  const cleanup = Cause.annotate(Cause.die(secondary), Context.make(FailureRoleAnnotation, "cleanup"));
  const exit = await Effect.runPromiseExit(
    Effect.scoped(
      Effect.gen(function* () {
        yield* Effect.addFinalizer(() => Effect.failCause(cleanup));
        return yield* Effect.fail(primary);
      }),
    ),
  );
  expect(Exit.isFailure(exit)).toBe(true);
  if (Exit.isFailure(exit))
    expect(failureOutcomeFromCause(exit.cause)).toMatchObject({
      error: primary,
      additionalErrors: [{ role: "cleanup", error: secondary }],
    });
});

test("keeps an unannotated operation primary even after an earlier annotated typed failure", () => {
  const reordered = Cause.combine(
    Cause.annotate(Cause.fail(secondary), Context.make(FailureRoleAnnotation, "rollback")),
    Cause.fail(primary),
  );
  expect(failureOutcomeFromCause(reordered)).toEqual({
    _tag: "failure",
    error: primary,
    additionalErrors: [{ role: "rollback", error: secondary }],
  });
});

test("siblings inside compensation inherit the rollback role", async () => {
  const sibling = new OperationError({ message: "sibling" });
  const exit = await Effect.runPromiseExit(
    compensateFailure(
      Effect.fail(primary),
      runAllAndMergeFailures([Effect.fail(secondary), Effect.fail(sibling)]),
    ),
  );
  expect(Exit.isFailure(exit)).toBe(true);
  if (Exit.isFailure(exit))
    expect(failureOutcomeFromCause(exit.cause).additionalErrors).toEqual([
      { role: "rollback", error: secondary },
      { role: "rollback", error: sibling },
    ]);
});

test("independent sibling failures remain peers", async () => {
  const exit = await Effect.runPromiseExit(
    runAllAndMergeFailures([Effect.fail(primary), Effect.fail(secondary)]),
  );
  expect(Exit.isFailure(exit)).toBe(true);
  if (Exit.isFailure(exit))
    expect(failureOutcomeFromCause(exit.cause).additionalErrors).toEqual([
      { role: "peer", error: secondary },
    ]);
});

test("bookkeeping inside rollback keeps its more specific cleanup role", () => {
  const cleanup = new OperationError({ message: "journal write" });
  const rollback = mergeFailure(Cause.fail(secondary), Cause.fail(cleanup), "cleanup");
  const result = mergeFailure(Cause.fail(primary), rollback, "rollback");
  expect(failureOutcomeFromCause(result).additionalErrors).toEqual([
    { role: "rollback", error: secondary },
    { role: "cleanup", error: cleanup },
  ]);
});
