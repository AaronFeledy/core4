import { expect, test } from "bun:test";
import { Cause, Effect, Exit, Option } from "effect";
import { checkedTransferCommand } from "../src/command-failure.ts";

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
