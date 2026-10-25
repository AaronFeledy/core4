import { expect, test } from "bun:test";
import {
  FailureRoleAnnotation,
  annotateFailureRole,
  commandFailureCause,
  encodeCommandResult,
  failureDefectCause,
  failureOutcomeFromCause,
  identityRedactor,
  mergeFailure,
} from "@lando/sdk/command-result";
import { CommandResultEnvelope } from "@lando/sdk/schema";
import { Cause, Context, Effect, Schema } from "effect";

test.each(["rollback", "cleanup", "peer"] as const)(
  "selects an unannotated defect ahead of a %s typed failure",
  (role) => {
    const operation = new Error("operation");
    const secondary = { _tag: "SecondaryError", message: "secondary" };
    const cause = Cause.combine(
      Cause.annotate(Cause.fail(secondary), Context.make(FailureRoleAnnotation, role)),
      Cause.die(operation),
    );
    expect(failureOutcomeFromCause(cause)).toEqual({
      _tag: "failure",
      error: operation,
      additionalErrors: [{ role, error: secondary }],
    });
  },
);

test("falls back to the first typed failure when every reason has a role", () => {
  const cause = Cause.combine(
    Cause.annotate(Cause.die("defect"), Context.make(FailureRoleAnnotation, "cleanup")),
    Cause.annotate(Cause.fail("typed"), Context.make(FailureRoleAnnotation, "rollback")),
  );
  expect(failureOutcomeFromCause(cause)).toEqual({
    _tag: "failure",
    error: "typed",
    additionalErrors: [{ role: "cleanup", error: "defect" }],
  });
});

test("nested command defect conversion preserves unrelated annotations and roles", () => {
  const extra = Context.Reference("test/annotation", { defaultValue: () => "absent" });
  const cause = Cause.annotate(
    Cause.die("nested"),
    Context.make(FailureRoleAnnotation, "rollback").pipe(Context.add(extra, "present")),
  );
  const converted = commandFailureCause(cause);
  const reason = converted.reasons[0];
  expect(reason?._tag).toBe("Fail");
  if (reason !== undefined) {
    expect(Context.get(Cause.reasonAnnotations(reason), extra)).toBe("present");
    expect(Context.getOrUndefined(Cause.reasonAnnotations(reason), FailureRoleAnnotation)).toBe("rollback");
  }
});

test("reserves the encoder-owned role against an error's colliding field", () => {
  const output = Effect.runSync(
    encodeCommandResult({
      command: "app:start",
      resultSchema: Schema.Void,
      redactor: identityRedactor,
      outcome: {
        _tag: "failure",
        error: { _tag: "Primary", message: "primary", role: "spoof" },
        additionalErrors: [
          { role: "rollback", error: { _tag: "Secondary", message: "secondary", role: "spoof" } },
        ],
      },
    }),
  );
  const envelope = Schema.decodeUnknownSync(CommandResultEnvelope)(JSON.parse(output));
  expect(envelope.error).toEqual({
    _tag: "Primary",
    message: "primary",
    additionalErrors: [{ _tag: "Secondary", message: "secondary", role: "rollback" }],
  });
});

test.each([undefined, "other"])("rejects a missing or unknown machine role: %s", (role) => {
  const decoded = Schema.decodeUnknownResult(CommandResultEnvelope)({
    apiVersion: "v4",
    command: "app:start",
    ok: false,
    warnings: [],
    deprecations: [],
    error: {
      _tag: "Primary",
      message: "primary",
      additionalErrors: [{ _tag: "Secondary", message: "secondary", role }],
    },
  });
  expect(decoded._tag).toBe("Failure");
});

test("annotateFailureRole keeps a more specific role and does not retag an interrupt", () => {
  const cleanup = { _tag: "CleanupError", message: "journal" };
  const peer = { _tag: "PeerError", message: "peer" };
  const cause = annotateFailureRole(
    Cause.combine(
      Cause.combine(
        Cause.annotate(Cause.fail(cleanup), Context.make(FailureRoleAnnotation, "cleanup")),
        Cause.fail(peer),
      ),
      Cause.interrupt(7),
    ),
    "rollback",
  );
  const roles = cause.reasons.flatMap((reason) => {
    if (!Cause.isFailReason(reason)) return [];
    return [
      {
        error: reason.error,
        role: Context.getOrUndefined(Cause.reasonAnnotations(reason), FailureRoleAnnotation),
      },
    ];
  });
  expect(roles).toEqual([
    { error: cleanup, role: "cleanup" },
    { error: peer, role: "rollback" },
  ]);
  expect(Cause.hasInterrupts(cause)).toBe(true);
  const interrupt = cause.reasons.find(Cause.isInterruptReason);
  expect(interrupt).toBeDefined();
  if (interrupt !== undefined) {
    expect(Context.getOrUndefined(Cause.reasonAnnotations(interrupt), FailureRoleAnnotation)).toBeUndefined();
  }
});

test("mergeFailure keeps an unscoped primary ahead of the annotated cause", () => {
  const primary = { _tag: "VolumeOperationError", message: "completed", details: { exitCode: 9 } };
  const cleanup = { _tag: "ProviderUnavailableError", message: "removal failed" };
  const cause = mergeFailure(Cause.fail(primary), Cause.fail(cleanup), "cleanup");
  expect(failureOutcomeFromCause(cause)).toEqual({
    _tag: "failure",
    error: primary,
    additionalErrors: [{ role: "cleanup", error: cleanup }],
  });
});

test("failureDefectCause preserves the tagged error and cleanup role for projection", () => {
  const cleanup = { _tag: "ProviderUnavailableError", message: "removal failed" };
  const cause = failureDefectCause(annotateFailureRole(Cause.fail(cleanup), "cleanup"));
  const reason = cause.reasons[0];
  expect(reason === undefined ? undefined : Cause.isDieReason(reason)).toBe(true);
  if (reason !== undefined) {
    expect(Context.getOrUndefined(Cause.reasonAnnotations(reason), FailureRoleAnnotation)).toBe("cleanup");
  }
  expect(failureOutcomeFromCause(cause)).toEqual({
    _tag: "failure",
    error: cleanup,
    additionalErrors: [],
  });
});
