import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RedactionService, makeRedactionService } from "@lando/redaction/service";
import { SecretNotFoundError } from "@lando/sdk/errors";
import type { ShellReplInput } from "@lando/sdk/services";
import { Effect, Layer } from "effect";
import { runHostShellRepl } from "../../src/services/host-shell-repl.ts";
import { ownerOnlyFileAccess } from "../private-file-access.ts";

test.each(
  [true, false].flatMap((service) =>
    ["parent", "caller"].flatMap((source) => [true, false].map((throws) => ({ service, source, throws }))),
  ),
)(
  "redacts rotated $source secret lookup failures with service=$service and throwing IO=$throws",
  async ({ service, source, throws }) => {
    // Given
    const root = await mkdtemp(join(tmpdir(), "lando-repl-lookup-redaction-"));
    const historyFile = join(root, "history");
    const marker = join(root, "child");
    const key = "LANDO_REPL_LOOKUP_API_TOKEN";
    const previous = process.env[key];
    process.env[key] = "session-start-canary";
    const env: Record<string, string> = source === "caller" ? { [key]: "caller-start-canary" } : {};
    const canary = "later-line-canary";
    const stderr: string[] = [];
    const references: string[] = [];
    const input: AsyncIterable<ShellReplInput> = (async function* () {
      yield { _tag: "interrupt" };
      if (source === "caller") env[key] = canary;
      else process.env[key] = canary;
      yield { _tag: "line", line: `touch '${marker}'; printf '%s' \${secret:MISSING}` };
      yield { _tag: "line", line: "exit" };
    })();
    try {
      // When
      const result = await Effect.runPromise(
        Effect.result(
          runHostShellRepl(
            {
              env,
              historyFile,
              resolveSecret: (reference) => {
                references.push(reference);
                return Effect.fail(
                  new SecretNotFoundError({ message: canary, secret: reference, remediation: "set it" }),
                );
              },
              io: {
                input,
                writeStdout: () => {},
                writeStderr: (chunk) => {
                  stderr.push(chunk);
                  if (throws) throw new TypeError(canary);
                },
              },
            },
            ownerOnlyFileAccess,
          ),
        ).pipe(
          Effect.provide(service ? Layer.succeed(RedactionService, makeRedactionService()) : Layer.empty),
        ),
      );
      // Then
      expect(stderr.join("")).toBe("[redacted]\n");
      expect(references).toEqual(["MISSING"]);
      expect(result).toMatchObject(
        throws
          ? { _tag: "Failure", failure: { message: "[redacted]" } }
          : { _tag: "Success", success: { exitCode: 130 } },
      );
      expect(JSON.stringify(result)).not.toContain(canary);
      expect(await Bun.file(historyFile).exists()).toBe(false);
      expect(await Bun.file(marker).exists()).toBe(false);
    } finally {
      if (previous === undefined) delete process.env[key];
      else process.env[key] = previous;
      await rm(root, { recursive: true, force: true });
    }
  },
);

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
  const redaction = makeRedactionService();
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
