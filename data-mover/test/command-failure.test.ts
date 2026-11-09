import { expect, test } from "bun:test";
import { RedactionService } from "@lando/redaction/service";
import { encodeCommandResult, identityRedactor, taggedErrorJson } from "@lando/sdk/command-result";
import {
  annotateFailureRole,
  failureDefectCause,
  failureOutcomeFromCause,
  mergeFailure,
} from "@lando/sdk/command-result";
import { ProviderUnavailableError } from "@lando/sdk/errors";
import { Cause, Effect, Exit, Schema, Stream } from "effect";
import { checkedTransferCommand } from "../src/command-failure.ts";

const bytes = (text: string) => new TextEncoder().encode(text);
const failed = async <A>(effect: Effect.Effect<A, unknown>) => {
  const exit = await Effect.runPromiseExit(effect);
  if (!Exit.isFailure(exit)) throw new Error("Expected failure");
  return failureOutcomeFromCause(exit.cause);
};

test.each([undefined, "peer", "rollback"] as const)(
  "sanitizes provider failures while preserving role %s",
  async (role) => {
    const raw = Cause.fail(
      new ProviderUnavailableError({
        providerId: "test",
        operation: "runStream",
        message: "PRIVATE",
        cause: "PRIVATE",
        details: { exitCode: 7, stderrTail: "PRIVATE" },
        remediation: "Start the runtime, then retry.",
      }),
    );
    const source = Stream.failCause(role === undefined ? raw : annotateFailureRole(raw, role));
    const outcome = await failed(checkedTransferCommand(source, "exec", ["PRIVATE"]));
    expect(outcome.error).toMatchObject({
      _tag: "DataTransferError",
      reason: "provider",
      exitCode: undefined,
      stderrTail: undefined,
      cause: { _tag: "ProviderUnavailableError", message: "[redacted]" },
      remediation: "Start the runtime, then retry.",
    });
    expect(JSON.stringify(outcome)).not.toContain("PRIVATE");
    expect(JSON.stringify(taggedErrorJson(outcome.error))).not.toContain("PRIVATE");
  },
);

test("preserves primary and cleanup reasons with distinct remediation", async () => {
  const cause = mergeFailure(
    Cause.fail({ message: "PRIVATE" }),
    Cause.fail({ message: "PRIVATE" }),
    "cleanup",
  );
  const outcome = await failed(checkedTransferCommand(Stream.failCause(cause), "run"));
  expect(outcome.error).toMatchObject({
    reason: "provider",
    remediation: "Inspect the service command and retry after the service is healthy.",
  });
  expect(outcome.additionalErrors).toEqual([
    {
      role: "cleanup",
      error: expect.objectContaining({
        reason: "provider",
        remediation: expect.stringContaining("may already have completed"),
      }),
    },
  ]);
  expect(JSON.stringify(outcome)).not.toContain("PRIVATE");
});

test.each([false, true])(
  "encoded transfer failure keeps provider identity with live registry=%s",
  async (live) => {
    const secret = "transfer-authoritative-canary";
    const late = "transfer-late-canary";
    const original = new ProviderUnavailableError({
      providerId: "test",
      operation: "exec",
      message: `Cannot connect ${secret} ${late} https://user:transfer-url-canary@example.test`,
      remediation: "Start the runtime and retry.",
      cause: "nested-transfer-canary",
    });
    const effect = Effect.gen(function* () {
      const service = yield* Effect.serviceOption(RedactionService);
      const source = Stream.unwrap(
        Effect.gen(function* () {
          if (service._tag === "Some") yield* service.value.registerValues([late]);
          return Stream.fail(original);
        }),
      );
      return yield* checkedTransferCommand(source, "exec", [secret, ...(live ? [] : [late])]).pipe(
        Effect.exit,
      );
    });
    const exit = await Effect.runPromise(
      live ? effect.pipe(Effect.provide(RedactionService.layer), Effect.scoped) : effect,
    );
    if (!Exit.isFailure(exit)) throw new Error("Expected transfer failure");
    const outcome = failureOutcomeFromCause(exit.cause);
    expect(outcome.error).toMatchObject({
      cause: { _tag: original._tag },
      remediation: original.remediation,
    });
    const encoded = await Effect.runPromise(
      encodeCommandResult({
        command: "transfer",
        resultSchema: Schema.Void,
        outcome,
        redactor: identityRedactor,
      }),
    );
    for (const value of [secret, late, "transfer-url-canary", "nested-transfer-canary"]) {
      expect(encoded).not.toContain(value);
      expect(JSON.stringify(taggedErrorJson(outcome.error))).not.toContain(value);
    }
  },
);

test.each(["exec", "run"])(
  "discards arbitrary stdout while preserving safe stderr for %s",
  async (operation) => {
    const source = Stream.make(
      { kind: "stdout" as const, chunk: new Uint8Array(16 * 1024 * 1024) },
      { kind: "stderr" as const, chunk: bytes("cannot load database; lando\n") },
      { exitCode: 4 },
    );
    const outcome = await failed(checkedTransferCommand(source, operation, ["lando"]));
    expect(outcome.error).toMatchObject({
      exitCode: 4,
      reason: "exit",
      stderrTail: "cannot load database; [redacted]\n",
    });
  },
);

test("observes live registrations and keeps diagnostics within 8 KiB", async () => {
  const outcome = await Effect.runPromise(
    Effect.gen(function* () {
      const redaction = yield* RedactionService;
      yield* redaction.registerValues(["UNICODE_PRIVATE"]);
      return yield* checkedTransferCommand(
        Stream.make(
          { kind: "stderr", chunk: bytes(`${"界é diagnostic\n".repeat(900)}last UNICODE_PRIVATE\n`) },
          { exitCode: 7 },
        ),
        "exec",
      ).pipe(Effect.result);
    }).pipe(Effect.provide(RedactionService.layer), Effect.scoped),
  );
  if (outcome._tag !== "Failure") throw new Error("Expected failure");
  const diagnostic = outcome.failure.stderrTail ?? "";
  expect(bytes(diagnostic).length).toBeLessThanOrEqual(8192);
  expect(diagnostic).toContain("last [redacted]");
  expect(diagnostic).not.toContain("�");
});

test("sanitizes scoped cleanup defects beside observed command exit", async () => {
  const source = Stream.unwrap(
    Effect.gen(function* () {
      yield* Effect.addFinalizer(() =>
        Effect.failCause(
          failureDefectCause(
            annotateFailureRole(
              Cause.fail({ _tag: "ProviderUnavailableError", message: "PRIVATE", cause: "PRIVATE" }),
              "cleanup",
            ),
          ),
        ),
      );
      return Stream.make({ exitCode: 9 });
    }),
  );
  const outcome = await failed(checkedTransferCommand(source, "run"));
  expect(outcome.error).toMatchObject({ reason: "exit", exitCode: 9 });
  expect(outcome.additionalErrors).toEqual([
    {
      role: "cleanup",
      error: expect.objectContaining({
        reason: "provider",
        exitCode: 9,
        remediation: expect.stringContaining("may already have completed"),
      }),
    },
  ]);
  expect(JSON.stringify(outcome)).not.toContain("PRIVATE");
});

test("preserves interruption instead of converting it to a transfer failure", async () => {
  const exit = await Effect.runPromiseExit(
    checkedTransferCommand(Stream.fromEffect(Effect.interrupt), "exec"),
  );
  if (!Exit.isFailure(exit)) throw new Error("Expected interruption");
  expect(Cause.hasInterrupts(exit.cause)).toBe(true);
  expect(Cause.hasFails(exit.cause)).toBe(false);
});
