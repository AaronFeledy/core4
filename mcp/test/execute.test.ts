import { describe, expect, test } from "bun:test";
import { outcomeFromExit } from "@lando/mcp/execute";
import { buildCommandResultEnvelope, normalizeDefect } from "@lando/sdk/command-result";
import { createRedactor } from "@lando/sdk/secrets";
import { Cause, Effect, Exit, Schema } from "effect";

describe("MCP failure projection", () => {
  test("retains combined failures in the command outcome and machine envelope", () => {
    // Given: an operation failure, an interrupt, and a cleanup failure.
    const primary = { _tag: "StartError", message: "start", remediation: "repair start" };
    const secondary = { _tag: "CleanupError", message: "cleanup", remediation: "repair cleanup" };
    const cause = Cause.combine(
      Cause.fail(primary),
      Cause.combine(Cause.interrupt(1), Cause.fail(secondary)),
    );
    // When: MCP projects the exit and builds its response envelope.
    const outcome = Effect.runSync(outcomeFromExit(Exit.failCause(cause)));
    const envelope = Effect.runSync(
      buildCommandResultEnvelope({
        command: "app:start",
        resultSchema: Schema.Void,
        outcome,
        redactor: createRedactor("secrets", { values: [] }),
      }),
    );
    // Then: both surfaces carry the same primary and ordered additional failure.
    expect(outcome).toEqual({
      _tag: "failure",
      error: primary,
      additionalErrors: [{ role: "peer", error: secondary }],
    });
    expect(envelope.error).toEqual({ ...primary, additionalErrors: [{ ...secondary, role: "peer" }] });
  });

  test("prioritizes a typed failure over an earlier defect and preserves additional error order", () => {
    // Given: a defect precedes the typed failure, with cancellation and another failure after it.
    const defect = new Error("early defect");
    const primary = { _tag: "StartError", message: "start" };
    const secondary = { _tag: "CleanupError", message: "cleanup" };
    const cause = Cause.fromReasons([
      Cause.makeDieReason(defect),
      Cause.makeFailReason(primary),
      Cause.makeInterruptReason(1),
      Cause.makeFailReason(secondary),
    ]);
    // When: MCP projects the failed exit.
    const outcome = Effect.runSync(outcomeFromExit(Exit.failCause(cause)));
    // Then: the typed failure is primary and the remaining errors retain cause order.
    expect(outcome).toEqual({
      _tag: "failure",
      error: primary,
      additionalErrors: [
        { role: "peer", error: normalizeDefect(defect) },
        { role: "peer", error: secondary },
      ],
    });
  });

  test("uses the first defect as primary when no typed failure exists", () => {
    // Given: two defects separated by an interrupt.
    const primary = new Error("operation crashed");
    const secondary = new Error("cleanup crashed");
    const cause = Cause.combine(Cause.die(primary), Cause.combine(Cause.interrupt(1), Cause.die(secondary)));
    // When: MCP projects the failed exit.
    const outcome = Effect.runSync(outcomeFromExit(Exit.failCause(cause)));
    // Then: defects remain separate and the interrupt is excluded.
    expect(outcome).toEqual({
      _tag: "failure",
      error: normalizeDefect(primary),
      additionalErrors: [{ role: "peer", error: normalizeDefect(secondary) }],
    });
  });

  test("propagates interrupt-only exits", () => {
    // Given: cancellation without errors.
    const exit = Exit.failCause(Cause.interrupt(1));
    // When: MCP projects the exit.
    const projected = Effect.runSyncExit(outcomeFromExit(exit));
    // Then: cancellation remains an interruption, not a tool failure.
    expect(Exit.isFailure(projected) && Cause.hasInterruptsOnly(projected.cause)).toBe(true);
  });
});
