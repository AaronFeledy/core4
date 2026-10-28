import { expect, test } from "bun:test";
import {
  encodeCommandResult,
  identityRedactor,
  normalizeDefect,
  taggedErrorJson,
} from "@lando/sdk/command-result";
import {
  ComposeKeyRejectedError,
  LandoInternalError,
  LandofileParseError,
  ManagedFileTransactionError,
  RecipeSourceError,
} from "@lando/sdk/errors";
import { CommandResultEnvelope, TaggedErrorJson } from "@lando/sdk/schema";
import { Effect, Schema } from "effect";

test("projects declared non-enumerable error fields without exposing runtime source locations", () => {
  // Given real tagged errors, including fields that collide with Bun's Error metadata.
  const parse = new LandofileParseError({
    message: "Invalid YAML.",
    filePath: "/app/.lando.yml",
    line: 3,
    column: 2,
    remediation: "Correct the YAML syntax.",
  });
  const compose = new ComposeKeyRejectedError({
    message: "Unsupported key.",
    source: "/app/.lando.yml",
    service: "web",
    keyPath: "deploy.replicas",
    remediation: "Remove the unsupported key.",
  });

  // When each error crosses the shared diagnostic boundary.
  const projected = taggedErrorJson(parse);
  const unrelated = taggedErrorJson(compose);

  // Then authored locations survive, but construct-site metadata does not.
  expect(projected).toMatchObject({ filePath: "/app/.lando.yml", line: 3, column: 2 });
  expect(unrelated).not.toHaveProperty("line");
  expect(unrelated).not.toHaveProperty("column");
  expect(projected).not.toHaveProperty("sourceURL");
  expect(projected).not.toHaveProperty("stack");
});

test.each(["pending-transaction", "blocked"] as const)(
  "preserves the human explanation for a %s transaction at the diagnostic boundary",
  (reason) => {
    // Given an expected transaction refusal, not an unexpected internal failure.
    const error = new ManagedFileTransactionError({
      reason,
      phase: "inspect",
      path: "/app",
      cause: "invariant",
      remediation: "Inspect the previous file update before retrying.",
    });
    const message = error.message;
    // When the error is projected through the accessor-safe wire boundary.
    const diagnostic = taggedErrorJson(error);
    // Then its real explanation and actionable context survive projection.
    expect(diagnostic).toMatchObject({
      _tag: "ManagedFileTransactionError",
      message,
      reason,
      phase: "inspect",
      path: "/app",
    });
  },
);

test.each([new Error("failure\n    at hidden-frame"), undefined, 42, "failure"])(
  "unknown failure %j becomes a schema-valid internal diagnostic",
  (error) => {
    const diagnostic = taggedErrorJson(error);
    expect(Schema.is(TaggedErrorJson)(diagnostic)).toBe(true);
    expect(diagnostic._tag).toBe("LandoInternalError");
    expect(diagnostic.remediation).toContain("--debug");
    expect(JSON.stringify(diagnostic)).not.toContain("hidden-frame");
  },
);

test.each([undefined, "", " \t\n"])("wire diagnostics reject blank remediation %j", (remediation) => {
  expect(
    Schema.decodeUnknownResult(TaggedErrorJson)({ _tag: "Example", message: "Failed", remediation })._tag,
  ).toBe("Failure");
});

test("an unencodable success yields a schema-valid actionable fallback", () => {
  const line = Effect.runSync(
    encodeCommandResult({
      command: "app:info",
      resultSchema: Schema.Number,
      outcome: { _tag: "success", value: "not a number" },
      redactor: identityRedactor,
    }),
  );
  const envelope = Schema.decodeUnknownSync(CommandResultEnvelope)(JSON.parse(line));
  expect(envelope).toMatchObject({ ok: false, error: { _tag: "CommandResultEncodeError" } });
  expect(envelope.error?.remediation).toContain("--debug");
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

test("a tagged error raised as a defect keeps its own tag and remediation", () => {
  // Given a well-formed tagged error that reached the boundary as a defect.
  const raised = new RecipeSourceError({
    kind: "missing-url",
    source: "git",
    message: "lando init --source=git requires --url=<git-url>.",
    remediation: "Pass --url=<git-url> with --source=git.",
  });
  // When the boundary normalizes the defect.
  const normalized = normalizeDefect(raised);
  // Then it is unchanged, so the user keeps the real tag and guidance.
  expect(normalized).toBe(raised);
});

test.each([
  ["a plain Error", new Error("boom")],
  ["a string", "boom"],
  ["an object with a tag but no remediation", { _tag: "SomethingError", message: "boom" }],
  ["an object with a blank remediation", { _tag: "SomethingError", message: "boom", remediation: "  " }],
])("%s becomes a LandoInternalError without its stack", (_label, defect) => {
  // Given an unexpected defect that is not a well-formed tagged error.
  // When the boundary normalizes it.
  const normalized = normalizeDefect(defect);
  // Then it is an internal error with a reporting remediation and no stack text.
  expect(normalized).toBeInstanceOf(LandoInternalError);
  expect(JSON.stringify(taggedErrorJson(normalized))).not.toMatch(/\n\s+at /u);
});
