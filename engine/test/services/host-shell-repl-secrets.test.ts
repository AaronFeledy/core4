import { expect, test } from "bun:test";
import { RedactionService, makeRedactionService } from "@lando/redaction/service";
import type { ShellReplInput } from "@lando/sdk/services";
import { Effect } from "effect";
import { runHostShellRepl } from "../../src/services/host-shell-repl.ts";
import { ownerOnlyFileAccess } from "../private-file-access.ts";

test("resolves ${secret:op://Vault/Item Name/field} with spaces", async () => {
  // Given
  const refs: string[] = [];
  const stdout: string[] = [];
  const stderr: string[] = [];
  const input: AsyncIterable<ShellReplInput> = (async function* () {
    yield { _tag: "line", line: "printf '%s' ${secret:op://Vault/Item Name/field}" };
    yield { _tag: "eof" };
  })();
  // When
  await Effect.runPromise(
    runHostShellRepl(
      {
        resolveSecret: (ref) =>
          Effect.sync(() => {
            refs.push(ref);
            return "shell-scheme-canary";
          }),
        io: { input, writeStdout: (chunk) => stdout.push(chunk), writeStderr: (chunk) => stderr.push(chunk) },
      },
      ownerOnlyFileAccess,
    ),
  );
  // Then
  expect(refs).toEqual(["op://Vault/Item Name/field"]);
  expect(stdout.join("").trim()).toBe("[redacted]");
  expect(stderr).toEqual([]);
});

test("registers shell secrets before returning to a retained redactor", async () => {
  // Given
  const redaction = makeRedactionService({
    id: "empty",
    get: () => Effect.succeed(""),
    has: () => Effect.succeed(false),
    list: Effect.succeed([]),
  });
  const redactor = await Effect.runPromise(redaction.forProfile("secrets"));
  const input: AsyncIterable<ShellReplInput> = (async function* () {
    yield { _tag: "line", line: "printf '%s' ${secret:op://Vault/Item/field}" };
    yield { _tag: "eof" };
  })();
  // When
  await Effect.runPromise(
    runHostShellRepl(
      {
        resolveSecret: () => Effect.succeed("retained-shell-canary"),
        io: { input, writeStdout: () => {}, writeStderr: () => {} },
      },
      ownerOnlyFileAccess,
    ).pipe(Effect.provideService(RedactionService, redaction)),
  );
  // Then
  expect(redactor.redactString("retained-shell-canary")).toBe("[redacted]");
});
