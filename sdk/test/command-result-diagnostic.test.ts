import { expect, test } from "bun:test";
import { encodeCommandResult, identityRedactor, taggedErrorJson } from "@lando/sdk/command-result";
import {
  ComposeKeyRejectedError,
  ConfigExpressionError,
  GlobalAppError,
  GlobalAutoStartError,
  LandofileIncludeError,
  LandofileLoadError,
  LandofileParseError,
  ManagedFileTransactionError,
  landofileLoadFailures,
} from "@lando/sdk/errors";
import { CommandResultEnvelope, TaggedErrorJson } from "@lando/sdk/schema";
import { Effect, Schema } from "effect";

test("preserves nested tagged causes without stacks (#2063)", () => {
  const error = new GlobalAutoStartError({
    app: "app1",
    services: ["traefik"],
    message: "Failed to auto-start global services.",
    cause: new GlobalAppError({
      message: "Applied state is unreadable.\n    at private-frame",
      remediation: "Restore the state file.",
      cause: { _tag: "StateStoreError", message: "Unsupported version.", stack: "private-stack" },
    }),
  });

  const projected = taggedErrorJson(error);

  expect(projected.cause).toMatchObject({
    _tag: "GlobalAppError",
    message: "Applied state is unreadable.",
    cause: { _tag: "StateStoreError", message: "Unsupported version." },
  });
  expect(JSON.stringify(projected)).not.toMatch(/private-frame|private-stack/u);
});

test.each([
  new Error("private"),
  "private",
  { message: "private" },
  { _tag: "Incomplete" },
  Object.create({ _tag: "Inherited", message: "private" }),
])("omits a non-tagged cause %j", (cause) => {
  expect(taggedErrorJson({ _tag: "Outer", message: "Failed.", cause })).not.toHaveProperty("cause");
});

test("omits cause cycles shared with aggregate failures", () => {
  const outer = { _tag: "Outer", message: "Failed." };
  const inner = { _tag: "Inner", message: "Reason.", cause: outer };
  Object.assign(outer, { cause: inner, failures: [inner] });

  const projected = taggedErrorJson(outer);

  expect(projected.cause).toMatchObject({ _tag: "Inner", message: "Reason." });
  expect(projected.cause).not.toHaveProperty("cause");
  expect(projected.failures).toMatchObject([{ _tag: "Inner", message: "Reason." }]);
  expect(projected).not.toHaveProperty("failures.0.cause");
});

test("bounds cause and failures recursion together at eight edges", () => {
  let error: unknown = { _tag: "Leaf", message: "Omitted." };
  let expected: object = { _tag: "Level8", message: "8" };
  for (let depth = 8; depth >= 0; depth--) {
    const fields = { _tag: `Level${depth}`, message: String(depth) };
    error = { ...fields, ...(depth % 2 === 0 ? { cause: error } : { failures: [error] }) };
    if (depth < 8)
      expected = { ...fields, ...(depth % 2 === 0 ? { cause: expected } : { failures: [expected] }) };
  }

  expect(taggedErrorJson(error)).toMatchObject(expected);
  expect(JSON.stringify(taggedErrorJson(error))).not.toContain("Omitted.");
});

test.each(["cause", "_tag", "message"])("does not invoke a cause's %s accessor", (field) => {
  let calls = 0;
  const cause = { _tag: "Inner", message: "Reason." };
  const error = { _tag: "Outer", message: "Failed.", cause };
  Object.defineProperty(field === "cause" ? error : cause, field, {
    get: () => {
      calls++;
      return "private";
    },
  });

  expect(taggedErrorJson(error)).not.toHaveProperty("cause");
  expect(calls).toBe(0);
});

test("expression failure provenance preserves literal namespace keys through the diagnostic boundary", () => {
  const source = {
    file: "/app/fragment.yml",
    layer: "local" as const,
    path: ["toolingIncludes", "docs.v2", "when"],
  };
  const error = new ConfigExpressionError({
    message: "Missing condition value.",
    expression: "{{ env.MISSING }}",
    filePath: source.file,
    path: source.path,
    source,
    remediation: "Provide the value or a default.",
  });
  const roundTrip = Schema.decodeUnknownSync(ConfigExpressionError)(
    Schema.encodeSync(ConfigExpressionError)(error),
  );
  expect(taggedErrorJson(roundTrip)).toMatchObject({ _tag: "ConfigExpressionError", source });
});

test("aggregate load failures survive schema round trips and command envelopes (#1646)", () => {
  const first = new LandofileParseError({
    message: "Invalid YAML",
    filePath: "/app/.lando.local.yml",
    line: 2,
    column: 3,
    cause: new Error("private"),
    remediation: "Fix YAML.",
  });
  const second = new LandofileIncludeError({
    message: "Missing include",
    file: "/app/.lando.yml",
    path: ["includes", 1],
    source: "./missing.yml",
    kind: "fetch-failed",
    remediation: "Fix the path.",
  });
  const error = new LandofileLoadError({
    file: "/app/.lando.yml",
    message: "Two failures",
    failures: [first, second],
    remediation: "Fix both.",
  });
  const roundTrip = Schema.decodeUnknownSync(LandofileLoadError)(
    Schema.encodeSync(LandofileLoadError)(error),
  );
  const line = Effect.runSync(
    encodeCommandResult({
      command: "app:start",
      resultSchema: Schema.Void,
      outcome: { _tag: "failure", error, additionalErrors: [] },
      redactor: identityRedactor,
    }),
  );
  const envelope = JSON.parse(line);
  expect(roundTrip.failures[0]).toBeInstanceOf(LandofileParseError);
  expect(landofileLoadFailures(first)).toEqual([first]);
  expect(envelope.error.failures).toMatchObject([
    { _tag: "LandofileParseError", line: 2 },
    { _tag: "LandofileIncludeError", path: ["includes", 1] },
  ]);
  expect(envelope.error.failures[0]).not.toHaveProperty("cause");
  expect(envelope.error.failures[1]).not.toHaveProperty("stack");
});

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

test("projects failures by field name without exposing member causes or looping over cycles", () => {
  const member = new LandofileIncludeError({
    file: "/app/.lando.yml",
    path: ["includes", 0],
    source: "./missing.yml",
    kind: "fetch-failed",
    message: "Missing fragment.",
    remediation: "Correct its path.",
  });
  const error = {
    _tag: "CustomAggregate",
    message: "Failed.",
    remediation: "Fix members.",
    failures: [member],
  };
  Object.assign(member, { cause: new Error("private"), failures: [error] });
  const projected = taggedErrorJson(error);
  expect(projected.failures).toEqual([
    {
      _tag: "LandofileIncludeError",
      file: "/app/.lando.yml",
      path: ["includes", 0],
      source: "./missing.yml",
      kind: "fetch-failed",
      message: "Missing fragment.",
      remediation: "Correct its path.",
      failures: [],
    },
  ]);
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
