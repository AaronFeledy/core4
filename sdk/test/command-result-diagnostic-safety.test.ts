import { expect, test } from "bun:test";
import { encodeCommandResult, identityRedactor, taggedErrorJson } from "@lando/sdk/command-result";
import { safeFileIoError } from "@lando/sdk/errors";
import { VerifiedStreamError } from "@lando/sdk/verified-stream";
import { Effect, Schema } from "effect";

test("command JSON retains the safe filesystem cause without any native payload", () => {
  const native = Object.assign(new Error("HOSTILE_MESSAGE"), {
    code: "ENOSPC",
    stack: "HOSTILE_STACK",
    payload: "HOSTILE_PAYLOAD",
    cause: { _tag: "Native", message: "HOSTILE_CAUSE" },
  });
  const error = new VerifiedStreamError({
    reason: "persist",
    message: "Failed to write artifact bytes.",
    cause: safeFileIoError("persist", "/host/dump.sql", native),
  });

  const line = Effect.runSync(
    encodeCommandResult({
      command: "db:export",
      resultSchema: Schema.Void,
      outcome: { _tag: "failure", error, additionalErrors: [] },
      redactor: identityRedactor,
    }),
  );

  expect(JSON.parse(line).error.cause).toEqual({
    _tag: "FileIoError",
    operation: "persist",
    reason: "no-space",
    path: "/host/dump.sql",
    message: "Failed to persist file at /host/dump.sql: The filesystem has no free space.",
    remediation: "Free space or inodes on the host filesystem, or choose another filesystem, then retry.",
  });
  expect(line).not.toMatch(/HOSTILE_|"stack"|"payload"|"code"/u);
});

test("typed diagnostic fields never invoke untrusted accessors or proxy traps", () => {
  let calls = 0;
  const issue = Object.defineProperty({}, "message", {
    enumerable: true,
    get: () => {
      calls++;
      return "unsafe";
    },
  });
  const steps = new Proxy([], {
    get: () => {
      calls++;
      return "unsafe";
    },
  });
  const diagnostic = taggedErrorJson({
    _tag: "Example",
    message: "Failed",
    remediation: "Repair configuration.",
    issues: [issue],
    steps,
  });
  expect(diagnostic).toEqual({ _tag: "Example", message: "Failed", remediation: "Repair configuration." });
  expect(calls).toBe(0);
});

test("does not invoke proxy traps on a wrapped cause", () => {
  let calls = 0;
  const cause = new Proxy(
    {},
    {
      getOwnPropertyDescriptor: () => {
        calls++;
        return undefined;
      },
    },
  );
  expect(taggedErrorJson({ _tag: "Outer", message: "Failed.", cause })).not.toHaveProperty("cause");
  expect(calls).toBe(0);
});
