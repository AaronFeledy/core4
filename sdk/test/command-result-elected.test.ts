import { expect, test } from "bun:test";
import {
  annotateFailureRole,
  failureOutcomeFromCause,
  normalizeDefect,
  orDieWithRole,
} from "@lando/sdk/command-result";
import { Cause, Effect, Exit, Schema } from "effect";

class StartError extends Schema.TaggedError<StartError>()("StartError", {
  message: Schema.String,
  remediation: Schema.String,
}) {}

class ReleaseError extends Schema.TaggedError<ReleaseError>()("ReleaseError", {
  message: Schema.String,
  remediation: Schema.String,
}) {}

const start = new StartError({ message: "start failed", remediation: "Fix start." });
const release = new ReleaseError({ message: "release failed", remediation: "Fix release." });
const crash = new Error("finalizer crashed");

const failedCause = (effect: Effect.Effect<unknown, unknown>) => {
  const exit = Effect.runSyncExit(effect);
  if (!Exit.isFailure(exit)) throw new Error("expected a failure");
  return exit.cause;
};

test("a typed failure stays the typed primary when a role-annotated cleanup dies", () => {
  // Given Effect elects the typed failure into a defect because the finalizer died.
  const cause = failedCause(
    Effect.fail(start).pipe(
      Effect.ensuring(Effect.failCause(annotateFailureRole(Cause.die(crash), "cleanup"))),
    ),
  );
  expect(cause.reasons.some(Cause.isFailReason)).toBe(false);
  // When the Cause is projected, then the typed failure is primary and the cleanup defect rides along.
  expect(failureOutcomeFromCause(cause, normalizeDefect)).toMatchObject({
    kind: "typed",
    source: "elected",
    error: start,
    additionalErrors: [{ role: "cleanup", error: { _tag: "LandoInternalError" } }],
  });
});

test("a typed failure stays primary when an unannotated finalizer dies", () => {
  const cause = failedCause(Effect.fail(start).pipe(Effect.ensuring(Effect.die(crash))));
  expect(failureOutcomeFromCause(cause)).toMatchObject({
    kind: "typed",
    source: "elected",
    error: start,
    additionalErrors: [{ role: "peer", error: crash }],
  });
});

test("a typed failure stays primary when a concurrent sibling dies first", async () => {
  // Given both siblings settle, and the defect lands ahead of the typed failure in Cause order.
  const settled = <E>(effect: Effect.Effect<never, E>) =>
    Effect.uninterruptible(Effect.yieldNow.pipe(Effect.andThen(effect)));
  const exit = await Effect.runPromiseExit(
    Effect.all([settled(Effect.die(crash)), settled(Effect.fail(start))], { concurrency: 2 }),
  );
  if (!Exit.isFailure(exit)) throw new Error("expected a failure");
  expect(exit.cause.reasons.map((reason) => reason._tag)).toEqual(["Die", "Die"]);
  // Then Cause order does not demote the typed failure.
  expect(failureOutcomeFromCause(exit.cause)).toMatchObject({
    kind: "typed",
    source: "elected",
    error: start,
    additionalErrors: [{ role: "peer", error: crash }],
  });
});

test("typed recovery that Effect skips still projects the typed primary", () => {
  const cause = failedCause(
    Effect.fail(start).pipe(
      Effect.ensuring(Effect.die(crash)),
      Effect.catchTag("StartError", () => Effect.void),
    ),
  );
  expect(failureOutcomeFromCause(cause)).toMatchObject({ kind: "typed", source: "elected", error: start });
});

test("a lone orDie of a tagged error stays a defect", () => {
  const cause = failedCause(Effect.orDie(Effect.fail(start)));
  expect(failureOutcomeFromCause(cause, normalizeDefect)).toMatchObject({ kind: "defect", error: start });
});

test("a release converted with orDieWithRole is never read back as the typed primary", () => {
  // Given a finalizer whose typed failure Lando deliberately turned into a cleanup defect beside another defect.
  const cause = failedCause(
    Effect.die(crash).pipe(Effect.ensuring(Effect.fail(release).pipe(orDieWithRole("cleanup")))),
  );
  // Then the converted release stays a cleanup defect and the crash is the primary defect.
  expect(failureOutcomeFromCause(cause)).toMatchObject({
    kind: "defect",
    error: crash,
    additionalErrors: [{ role: "cleanup", error: release }],
  });
});

test("a typed primary keeps priority over a release converted with orDieWithRole", () => {
  const cause = failedCause(
    Effect.fail(start).pipe(Effect.ensuring(Effect.fail(release).pipe(orDieWithRole("cleanup")))),
  );
  expect(failureOutcomeFromCause(cause)).toMatchObject({
    kind: "typed",
    source: "elected",
    error: start,
    additionalErrors: [{ role: "cleanup", error: release }],
  });
});

test("an elected error without remediation is reported as a defect", () => {
  // Given a typed failure that is not a Lando diagnostic error, so nothing proves it was typed.
  const cause = failedCause(
    Effect.fail({ _tag: "PlatformError", message: "raw" }).pipe(Effect.ensuring(Effect.die(crash))),
  );
  expect(failureOutcomeFromCause(cause, normalizeDefect)).toMatchObject({
    kind: "defect",
    error: { _tag: "LandoInternalError" },
  });
});

test("an interruption-only Cause has no failure kind", () => {
  expect(failureOutcomeFromCause(Cause.interrupt(1)).kind).toBe("none");
});
