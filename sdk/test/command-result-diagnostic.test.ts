import { expect, test } from "bun:test";
import { encodeCommandResult, identityRedactor, taggedErrorJson } from "@lando/sdk/command-result";
import { ComposeKeyRejectedError, LandofileParseError } from "@lando/sdk/errors";
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
