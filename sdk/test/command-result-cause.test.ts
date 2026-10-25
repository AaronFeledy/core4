import { describe, expect, test } from "bun:test";
import {
  encodeCommandResult,
  failureOutcomeFromCause,
  internalError,
  internalErrorRemediation,
} from "@lando/sdk/command-result";
import { CommandResultEnvelope } from "@lando/sdk/schema";
import { createRedactor } from "@lando/sdk/secrets";
import { Cause, Effect, Schema } from "effect";

describe("command failure projection", () => {
  test.each([
    { name: "empty", additionalErrors: [] },
    {
      name: "nested",
      additionalErrors: [
        {
          _tag: "CleanupError",
          message: "cleanup",
          remediation: "Repair cleanup.",
          role: "cleanup",
          additionalErrors: [],
        },
      ],
    },
  ])("rejects a $name additional-error collection on decode", ({ additionalErrors }) => {
    // Given: a wire envelope that violates the additional-error contract.
    const envelope = {
      apiVersion: "v4" as const,
      command: "app:start",
      ok: false,
      warnings: [],
      deprecations: [],
      error: { _tag: "StartError", message: "start", remediation: "Repair start.", additionalErrors },
    };
    // When: the public schema decodes the envelope.
    const decoded = Schema.decodeUnknownResult(CommandResultEnvelope)(envelope);
    // Then: invalid additional-error shapes are rejected, not silently accepted.
    expect(decoded._tag).toBe("Failure");
  });

  test("accepts one non-recursive additional error on decode", () => {
    // Given: a valid wire failure with one additional error and JSON-safe extra fields.
    const envelope = {
      apiVersion: "v4" as const,
      command: "app:start",
      ok: false,
      warnings: [],
      deprecations: [],
      error: {
        _tag: "StartError",
        message: "start",
        remediation: "Repair start.",
        additionalErrors: [
          {
            _tag: "CleanupError",
            role: "cleanup",
            message: "cleanup",
            remediation: "Retry cleanup.",
            operation: "stop",
          },
        ],
      },
    } as const;
    // When: the public schema decodes the envelope.
    const decoded = Schema.decodeUnknownSync(CommandResultEnvelope)(envelope);
    // Then: the valid additional error retains its fields.
    expect(decoded).toEqual(envelope);
  });

  test("projects Effect's normalized repeated cause without inventing additional failures", () => {
    // Given: the same failure cause appears twice.
    const primary = { _tag: "StartError", message: "failed" };
    const cause = Cause.fail(primary);
    // When: the normalized cause is projected.
    const outcome = failureOutcomeFromCause(Cause.combine(cause, cause));
    // Then: normalization does not invent an additional error.
    expect(outcome).toEqual({
      _tag: "failure",
      error: primary,
      additionalErrors: [],
    });
  });

  test.each([Cause.empty, Cause.interrupt(1)])(
    "squashes a cause without failures or defects: %s",
    (cause) => {
      // Given: a cause with no Fail or Die reason.
      const expected = Cause.squash(cause);
      // When: the cause is projected.
      const outcome = failureOutcomeFromCause(cause);
      // Then: the fallback matches Effect and has no additional errors.
      expect(outcome).toEqual({ _tag: "failure", error: expected, additionalErrors: [] });
    },
  );

  test("omits an explicitly empty additionalErrors collection from the envelope", () => {
    // Given: a failure outcome with an empty additional-error collection.
    const error = { _tag: "StartError", message: "failed", remediation: "Repair start." };
    // When: the outcome is encoded.
    const line = Effect.runSync(
      encodeCommandResult({
        command: "app:start",
        resultSchema: Schema.Void,
        outcome: { _tag: "failure", error, additionalErrors: [] },
        redactor: createRedactor("secrets", { values: [] }),
      }),
    );
    // Then: the optional collection is absent, not an empty array.
    expect(Schema.decodeUnknownSync(CommandResultEnvelope)(JSON.parse(line)).error).toEqual(error);
  });

  test("selects the first Fail ahead of defects and preserves additional cause order", () => {
    // Given: defects and interruptions surround two typed failures.
    const defect = new Error("cleanup crashed");
    const primary = { _tag: "StartError", message: "start failed", remediation: "Retry start." };
    const secondary = { _tag: "StopError", message: "stop failed", remediation: "Retry stop." };
    const cause = Cause.combine(
      Cause.combine(Cause.die(defect), Cause.interrupt(1)),
      Cause.combine(Cause.fail(primary), Cause.fail(secondary)),
    );
    // When: the cause is projected.
    const outcome = failureOutcomeFromCause(cause);
    // Then: the primary is typed and additional failures retain their original order.
    expect(outcome).toEqual({
      _tag: "failure",
      error: primary,
      additionalErrors: [
        { role: "peer", error: internalError(defect) },
        { role: "peer", error: secondary },
      ],
    });
  });

  test("uses the first defect when no Fail exists and ignores interruptions", () => {
    // Given: two defects separated by an interruption.
    const first = new Error("first");
    const second = new Error("second");
    const cause = Cause.combine(Cause.die(first), Cause.combine(Cause.interrupt(1), Cause.die(second)));
    // When: the cause is projected.
    const outcome = failureOutcomeFromCause(cause);
    // Then: neither interruption nor the primary is duplicated.
    expect(outcome).toEqual({
      _tag: "failure",
      error: internalError(first),
      additionalErrors: [{ role: "peer", error: internalError(second) }],
    });
  });

  test.each(["json", "yaml"] as const)("encodes non-recursive redacted additional errors in %s", (format) => {
    // Given: an additional defect and a tagged failure with a colliding reserved field.
    const secret = "private-cause-token";
    const primary = {
      _tag: "StartError",
      message: "start failed",
      remediation: "Repair start.",
      additionalErrors: ["spoof"],
    };
    const secondary = {
      _tag: "StopError",
      message: secret,
      remediation: secret,
      additionalErrors: ["nested"],
    };
    const cause = Cause.combine(
      Cause.fail(primary),
      Cause.combine(Cause.die(new Error(secret)), Cause.fail(secondary)),
    );
    // When: the projected failure is encoded and decoded through the public envelope.
    const line = Effect.runSync(
      encodeCommandResult({
        command: "app:start",
        resultSchema: Schema.Void,
        outcome: failureOutcomeFromCause(cause),
        redactor: createRedactor("secrets", { values: [secret] }),
        format,
      }),
    );
    const envelope = Schema.decodeUnknownSync(CommandResultEnvelope)(
      format === "json" ? JSON.parse(line) : Bun.YAML.parse(line),
    );
    // Then: extra entries retain their identity without stacks or nested additional errors.
    expect(envelope.error).toEqual({
      _tag: "StartError",
      message: "start failed",
      remediation: "Repair start.",
      additionalErrors: [
        {
          _tag: "LandoInternalError",
          role: "peer",
          message: "[redacted]",
          remediation: internalErrorRemediation,
        },
        { _tag: "StopError", role: "peer", message: "[redacted]", remediation: "[redacted]" },
      ],
    });
    expect(line).not.toContain("stack");
    expect(line).not.toContain(secret);
  });

  test("omits additionalErrors for a single failure even when its own fields collide", () => {
    // Given: one typed failure and an interruption.
    const primary = {
      _tag: "StartError",
      message: "failed",
      remediation: "Repair start.",
      additionalErrors: ["spoof"],
    };
    // When: the failure is projected and encoded.
    const outcome = failureOutcomeFromCause(Cause.combine(Cause.fail(primary), Cause.interrupt(1)));
    const line = Effect.runSync(
      encodeCommandResult({
        command: "app:start",
        resultSchema: Schema.Void,
        outcome,
        redactor: createRedactor("secrets", { values: [] }),
      }),
    );
    // Then: the optional collection is absent on both representations.
    expect(outcome).toEqual({ _tag: "failure", error: primary, additionalErrors: [] });
    expect(Schema.decodeUnknownSync(CommandResultEnvelope)(JSON.parse(line)).error).toEqual({
      _tag: "StartError",
      message: "failed",
      remediation: "Repair start.",
    });
  });
});
