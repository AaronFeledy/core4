import { expect, test } from "bun:test";
import { annotateFailureRole, failureOutcomeFromCause, mergeFailure } from "@lando/sdk/command-result";
import { Cause, Effect, Exit, Option } from "effect";
import { checkedTransferCommand } from "../src/command-failure.ts";

test.each([undefined, "peer", "rollback"] as const)(
  "uses ordinary remediation when a tagged failure has role %s and no exit evidence",
  async (role) => {
    // Given a non-cleanup failure with private context and no completion evidence.
    const secret = "PRIMARY_1789_SECRET";
    const failure = {
      _tag: "ProviderUnavailableError",
      message: `Provider startup failed: ${secret}`,
      cause: "PRIVATE CAUSE",
    };
    const cause = role === undefined ? Cause.fail(failure) : annotateFailureRole(Cause.fail(failure), role);
    // When the failure crosses the transfer boundary.
    const exit = await Effect.runPromiseExit(
      checkedTransferCommand(Effect.failCause(cause), "run", { MYSQL_PWD: secret }),
    );
    if (!Exit.isFailure(exit)) throw new Error("expected failure");
    const error = Option.getOrThrow(Cause.findErrorOption(exit.cause));
    // Then safe context survives without suggesting that cleanup or completion occurred.
    expect(error.message).toBe("Provider startup failed: [redacted]");
    expect(error.remediation).toBe("Inspect the service command and retry after the service is healthy.");
    expect(error.exitCode).toBeUndefined();
    expect(error.stderrTail).toBeUndefined();
    expect(error.cause).toBeUndefined();
    expect(JSON.stringify(error)).not.toMatch(/PRIMARY_1789_SECRET|PRIVATE CAUSE/u);
  },
);

test("keeps primary and cleanup remediation distinct when neither has exit evidence", async () => {
  // Given startup and removal failures, each with a tagged diagnostic but no exit code.
  const primary = { _tag: "VolumeOperationError", message: "Start failed: MIXED_SECRET", cause: "PRIVATE" };
  const cleanup = {
    _tag: "ProviderUnavailableError",
    message: "Remove failed: MIXED_SECRET",
    cause: "PRIVATE",
  };
  const cause = mergeFailure(Cause.fail(primary), Cause.fail(cleanup), "cleanup");
  // When both reasons cross the same transfer boundary.
  const exit = await Effect.runPromiseExit(
    checkedTransferCommand(Effect.failCause(cause), "run", { MYSQL_PWD: "MIXED_SECRET" }),
  );
  if (!Exit.isFailure(exit)) throw new Error("expected failure");
  // Then only the cleanup reason receives the caution about repeating a completed transfer.
  const outcome = failureOutcomeFromCause(exit.cause);
  expect(outcome.error).toMatchObject({
    message: "Start failed: [redacted]",
    remediation: "Inspect the service command and retry after the service is healthy.",
  });
  expect(outcome.additionalErrors).toEqual([
    {
      role: "cleanup",
      error: expect.objectContaining({
        message: "Remove failed: [redacted]",
        remediation: expect.stringContaining("may already have completed"),
      }),
    },
  ]);
  expect(JSON.stringify(outcome)).not.toMatch(/MIXED_SECRET|PRIVATE/u);
});

test.each(["exec", "run"])("keeps safe destination diagnostics without stdout for %s", async (operation) => {
  const exit = await Effect.runPromiseExit(
    checkedTransferCommand(
      Effect.succeed({ exitCode: 4, stdout: "PRIVATE DUMP", stderr: "cannot load database; lando\n" }),
      operation,
      { MYSQL_PWD: "lando" },
    ),
  );
  if (!Exit.isFailure(exit)) throw new Error("expected failure");
  const error = Option.getOrThrow(Cause.findErrorOption(exit.cause));
  expect(error.exitCode).toBe(4);
  expect(error.stderrTail).toContain("cannot load database");
  expect(error.stderrTail).not.toContain("lando");
  expect(error.cause).toBeUndefined();
  expect(JSON.stringify(error)).not.toContain("PRIVATE DUMP");
});

test("does not manufacture diagnostics from a provider execution failure", async () => {
  const result = await Effect.runPromise(
    checkedTransferCommand(Effect.fail("raw private error"), "exec").pipe(Effect.result),
  );
  if (result._tag !== "Failure") throw new Error("expected failure");
  expect(result.failure.exitCode).toBeUndefined();
  expect(result.failure.stderrTail).toBeUndefined();
  expect(JSON.stringify(result.failure)).not.toContain("raw private error");
});

test("preserves interruption instead of converting it to a transfer failure", async () => {
  const exit = await Effect.runPromiseExit(checkedTransferCommand(Effect.interrupt, "exec"));
  if (!Exit.isFailure(exit)) throw new Error("expected interruption");
  expect(Cause.hasInterrupts(exit.cause)).toBe(true);
  expect(Option.isNone(Cause.findErrorOption(exit.cause))).toBe(true);
});

test("preserves exit evidence and a cleanup role from a provider failure", async () => {
  const primary = {
    _tag: "VolumeOperationError",
    message: "completed",
    details: { exitCode: 9, stderrTail: "disk full" },
    cause: "SECRET",
  };
  const cleanup = { _tag: "ProviderUnavailableError", message: "Container removal failed.", cause: "SECRET" };
  const exit = await Effect.runPromiseExit(
    checkedTransferCommand(
      Effect.failCause(mergeFailure(Cause.fail(primary), Cause.fail(cleanup), "cleanup")),
      "run",
    ),
  );
  if (!Exit.isFailure(exit)) throw new Error("expected failure");
  const outcome = failureOutcomeFromCause(exit.cause);
  expect(outcome.error).toMatchObject({ _tag: "DataTransferError", exitCode: 9, stderrTail: "disk full" });
  expect(outcome.additionalErrors).toEqual([
    {
      role: "cleanup",
      error: expect.objectContaining({ _tag: "DataTransferError", message: "Container removal failed." }),
    },
  ]);
  expect(JSON.stringify(outcome)).not.toContain("SECRET");
});

test("redacts command secrets when a provider reports completion evidence", async () => {
  // Given provider completion evidence containing a command-only secret.
  const secret = "CANARY_1789_SECRET";
  const failure = {
    _tag: "VolumeOperationError",
    message: "failed",
    details: { exitCode: 9, stderrTail: `disk full ${secret}`, stdout: "PRIVATE DUMP" },
    cause: "PRIVATE CAUSE",
  };
  // When the failure crosses the transfer boundary.
  const exit = await Effect.runPromiseExit(
    checkedTransferCommand(Effect.fail(failure), "run", { MYSQL_PWD: secret }),
  );
  if (!Exit.isFailure(exit)) throw new Error("expected failure");
  const outcome = failureOutcomeFromCause(exit.cause);
  // Then completion context survives without private payloads.
  expect(outcome.error).toMatchObject({
    _tag: "DataTransferError",
    operation: "run",
    exitCode: 9,
    stderrTail: "disk full [redacted]",
  });
  expect(Option.getOrThrow(Cause.findErrorOption(exit.cause)).cause).toBeUndefined();
  expect(outcome.additionalErrors).toEqual([]);
  expect(JSON.stringify(outcome)).not.toMatch(/CANARY_1789_SECRET|PRIVATE DUMP|PRIVATE CAUSE/u);
});

test("redacts cleanup-only messages when the transfer may already have completed", async () => {
  // Given a cleanup failure with no failed-command exit evidence.
  const secret = "CLEANUP_1789_SECRET";
  const cleanup = { _tag: "ProviderUnavailableError", message: `Container removal failed: ${secret}` };
  // When cleanup is the only failure.
  const exit = await Effect.runPromiseExit(
    checkedTransferCommand(Effect.failCause(annotateFailureRole(Cause.fail(cleanup), "cleanup")), "run", {
      MYSQL_PWD: secret,
    }),
  );
  if (!Exit.isFailure(exit)) throw new Error("expected failure");
  const error = Option.getOrThrow(Cause.findErrorOption(exit.cause));
  // Then its context is safe and no command exit is invented.
  expect(error.message).toBe("Container removal failed: [redacted]");
  expect(error.remediation).toContain("may already have completed");
  expect(error.exitCode).toBeUndefined();
  expect(error.stderrTail).toBeUndefined();
});

test.each(["stderr", "message"] as const)(
  "bounds long Unicode %s evidence before publishing it",
  async (field) => {
    // Given evidence exceeding the tail budget but not the canonical context budget.
    const secret = "UNICODE_1789_SECRET";
    const evidence = `${"界é diagnostic\n".repeat(900)}last ${secret}\n`;
    const failure =
      field === "stderr"
        ? { _tag: "VolumeOperationError", message: "failed", details: { exitCode: 7, stderrTail: evidence } }
        : { _tag: "ProviderUnavailableError", message: evidence };
    // When either copied field crosses the transfer boundary.
    const exit = await Effect.runPromiseExit(
      checkedTransferCommand(Effect.fail(failure), "run", { MYSQL_PWD: secret }),
    );
    if (!Exit.isFailure(exit)) throw new Error("expected failure");
    const error = Option.getOrThrow(Cause.findErrorOption(exit.cause));
    const diagnostic = (field === "stderr" ? error.stderrTail : error.message) ?? "";
    // Then UTF-8 survives truncation and the final evidence remains redacted.
    expect(new TextEncoder().encode(diagnostic).length).toBeLessThanOrEqual(8192);
    expect(diagnostic).toContain("[diagnostic truncated]");
    expect(diagnostic).toContain("界é diagnostic");
    expect(diagnostic).toContain("last [redacted]");
    expect(diagnostic).not.toContain("�");
    expect(diagnostic).not.toContain(secret);
  },
);

test("keeps independently redacted evidence and roles when several cause reasons fail", async () => {
  // Given a suppressed primary tail, a cleanup message and independent peer completion evidence.
  const secret = "MULTI_1789_SECRET";
  const primary = { _tag: "VolumeOperationError", details: { exitCode: 9, stderrTail: "x".repeat(70000) } };
  const cleanup = {
    _tag: "ProviderUnavailableError",
    message: `remove failed ${secret}`,
    cause: "PRIVATE CAUSE",
  };
  const peer = {
    _tag: "VolumeOperationError",
    details: { exitCode: 23, stderrTail: `peer failed ${secret}` },
  };
  const cause = mergeFailure(
    mergeFailure(Cause.fail(primary), Cause.fail(cleanup), "cleanup"),
    Cause.fail(peer),
    "peer",
  );
  // When all reasons are mapped in the same command subscription.
  const exit = await Effect.runPromiseExit(
    checkedTransferCommand(Effect.failCause(cause), "run", { MYSQL_PWD: secret }),
  );
  if (!Exit.isFailure(exit)) throw new Error("expected failure");
  const outcome = failureOutcomeFromCause(exit.cause);
  // Then one collector's suppression or finish cannot contaminate another reason.
  expect(outcome.error).toMatchObject({ exitCode: 9, stderrTail: "[diagnostic truncated]" });
  expect(outcome.additionalErrors).toEqual([
    { role: "cleanup", error: expect.objectContaining({ message: "remove failed [redacted]" }) },
    { role: "peer", error: expect.objectContaining({ exitCode: 23, stderrTail: "peer failed [redacted]" }) },
  ]);
  expect(JSON.stringify(outcome)).not.toMatch(/MULTI_1789_SECRET|PRIVATE CAUSE/u);
});
