import { describe, expect, test } from "bun:test";

import { Either, Schema } from "effect";

import { CliCommandErrorEvent, CliCommandInitEvent, CliCommandRunEvent } from "@lando/sdk/events";

const timestamp = "2026-07-13T16:00:00.000Z";
const invocation = {
  commandId: "app:start",
  argv: ["start", "--service", "appserver"],
  args: { service: "appserver" },
  flags: { verbose: true },
  cwd: "/workspace/demo",
  app: { kind: "user", id: "demo", root: "/workspace/demo" },
  timestamp,
} as const;

describe("generic CLI lifecycle event schemas", () => {
  test("decodes a canonical dynamic init tag with invocation metadata", () => {
    // Given
    const payload = { _tag: "cli-app:start-init", ...invocation };

    // When
    const decoded = Schema.decodeUnknownEither(CliCommandInitEvent)(payload, {
      onExcessProperty: "error",
    });

    // Then
    expect(Either.isRight(decoded), String(Either.getLeft(decoded))).toBe(true);
  });

  test("allows init events without an app binding", () => {
    // Given
    const { app: _app, ...unboundInvocation } = invocation;

    // When
    const decoded = Schema.decodeUnknownEither(CliCommandInitEvent)({
      _tag: "cli-meta:version-init",
      ...unboundInvocation,
      commandId: "meta:version",
      argv: ["version"],
      args: {},
      flags: {},
    });

    // Then
    expect(Either.isRight(decoded), String(Either.getLeft(decoded))).toBe(true);
  });

  test("decodes a canonical dynamic run tag with terminal fields", () => {
    // Given
    const payload = {
      _tag: "cli-app:start-run",
      ...invocation,
      exitCode: 0,
      durationMs: 17,
    };

    // When
    const decoded = Schema.decodeUnknownEither(CliCommandRunEvent)(payload, {
      onExcessProperty: "error",
    });

    // Then
    expect(Either.isRight(decoded), String(Either.getLeft(decoded))).toBe(true);
  });

  test("decodes a canonical dynamic error tag with failure identity", () => {
    // Given
    const payload = {
      _tag: "cli-app:start-error",
      ...invocation,
      exitCode: 1,
      durationMs: 9,
      failureTag: "ProviderUnavailableError",
      message: "No provider is available.",
    };

    // When
    const decoded = Schema.decodeUnknownEither(CliCommandErrorEvent)(payload, {
      onExcessProperty: "error",
    });

    // Then
    expect(Either.isRight(decoded), String(Either.getLeft(decoded))).toBe(true);
  });
});
