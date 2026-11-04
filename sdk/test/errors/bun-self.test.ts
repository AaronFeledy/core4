import { expect, test } from "bun:test";
import { buildCommandResultEnvelope, identityRedactor } from "@lando/sdk/command-result";
import { BunSelfReentryError, PluginPackageOperationError } from "@lando/sdk/errors";
import { Effect, Schema } from "effect";

const execution = {
  message: "Package command failed.",
  remediation: "Fix the package command and retry.",
  commandId: "meta:plugin:add",
  operation: "postinstall",
  packageSpec: "@example/plugin@1.0.0",
  cwd: "/plugins/staging/package",
  exitCode: 42,
  detail: "captured diagnostic",
} as const;

test.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
  "rejects unknown or invalid child exit status %s",
  (exitCode) => {
    // Given / When
    const valid = Schema.is(PluginPackageOperationError)({
      ...execution,
      _tag: "PluginPackageOperationError",
      exitCode,
    });
    // Then
    expect(valid).toBe(false);
  },
);

test.each([1, 7, 42])("projects known package failure status %i with stage metadata", (exitCode) => {
  // Given
  const error = new PluginPackageOperationError({ ...execution, exitCode });
  // When
  const envelope = Effect.runSync(
    buildCommandResultEnvelope({
      command: "meta:plugin:add",
      resultSchema: Schema.Unknown,
      outcome: { _tag: "failure", error, additionalErrors: [] },
      redactor: identityRedactor,
    }),
  );
  // Then
  expect(Schema.is(PluginPackageOperationError)(error)).toBe(true);
  expect(envelope).toMatchObject({
    ok: false,
    error: { ...execution, exitCode, _tag: "PluginPackageOperationError" },
  });
});

test.each(["resolve", "download", "verify", "extract"] as const)(
  "represents %s failure without claiming a child ran",
  (operation) => {
    const { exitCode: _exitCode, ...fields } = execution;
    const error = new PluginPackageOperationError({ ...fields, operation });
    expect(Schema.is(PluginPackageOperationError)(error)).toBe(true);
    expect(JSON.parse(JSON.stringify(error))).not.toHaveProperty("exitCode");
  },
);

test("projects recursion context without inventing a child status or cause", () => {
  // Given
  const fields = {
    message: "Recursive invocation.",
    remediation: "Use Bun directly inside the child.",
    execPath: "/bin/lando",
    verb: "run",
    callerSubsystem: "plugin-install",
  };
  const error = new BunSelfReentryError(fields);
  // When
  const envelope = Effect.runSync(
    buildCommandResultEnvelope({
      command: "meta:bun",
      resultSchema: Schema.Unknown,
      outcome: { _tag: "failure", error, additionalErrors: [] },
      redactor: identityRedactor,
    }),
  );
  // Then
  expect(Schema.is(BunSelfReentryError)(error)).toBe(true);
  expect(envelope.error).toEqual({ ...fields, _tag: "BunSelfReentryError" });
});
