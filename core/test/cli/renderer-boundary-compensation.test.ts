import { describe, expect, test } from "bun:test";
import { createBufferedRendererIO } from "@lando/renderer/io";
import { CommandResultEnvelope } from "@lando/sdk/schema";
import { Cause, Effect, Layer, Schema } from "effect";
import { buildBugReport, formatBugReport } from "../../src/cli/bug-report";
import { runWithRendererHandling } from "../../src/cli/renderer-boundary";

class StartError extends Schema.TaggedError<StartError>()("StartError", {
  message: Schema.String,
  remediation: Schema.String,
}) {}
class CleanupError extends Schema.TaggedError<CleanupError>()("CleanupError", {
  message: Schema.String,
  remediation: Schema.String,
}) {}

describe("combined command failures", () => {
  test("omits additional failures when the supplied list is empty", () => {
    // Given: a primary failure without cleanup failures.
    const error = new StartError({ message: "Start refused.", remediation: "Repair start." });
    // When: the report receives an explicitly empty list.
    const report = buildBugReport({
      error,
      additionalErrors: [],
      context: { commandId: "app:start", cacheRoot: "/cache" },
    });
    // Then: the optional field is absent rather than an empty array.
    expect(report).not.toHaveProperty("additionalErrors");
  });

  test("keeps projected additional failures when a raw error has a colliding field", () => {
    // Given: an untrusted error field and a cleanup failure without remediation.
    const error = { _tag: "StartError", message: "Start refused.", additionalErrors: "spoofed" };
    // When: the JSON report receives the actual additional failure separately.
    const report = formatBugReport({
      error,
      additionalErrors: [
        {
          role: "cleanup",
          error: { _tag: "CleanupError", message: "Cleanup refused.", remediation: "Repair cleanup." },
        },
      ],
      context: { commandId: "app:start", cacheRoot: "/cache" },
      rendererMode: "json",
    });
    // Then: report-owned failures and their remediation survive.
    expect(JSON.parse(report).additionalErrors).toEqual([
      { role: "cleanup", code: "CleanupError", body: "Cleanup refused.", remediation: "Repair cleanup." },
    ]);
  });

  for (const rendererMode of ["plain", "lando", "verbose", "json"] as const) {
    test(`${rendererMode} renders primary and additional failures without stacks`, async () => {
      // Given: a typed operation failure followed by a secret-bearing cleanup failure.
      const primary = new StartError({ message: "Start refused.", remediation: "Repair start." });
      const secondary = new CleanupError({
        message: "Cleanup refused private-rollback-token.",
        remediation: "Repair cleanup private-rollback-token.",
      });
      const io = createBufferedRendererIO({ isTTY: rendererMode === "lando" });
      const exitCodes: number[] = [];
      // When: the real command boundary renders the combined cause.
      await runWithRendererHandling(
        Effect.failCause(Cause.combine(Cause.fail(primary), Cause.fail(secondary))),
        {
          runtime: Layer.empty,
          rendererMode,
          resultFormat: "text",
          command: "app:start",
          io,
          sourceEnv: {},
          extraRedactionTokens: ["private-rollback-token"],
          failureExitCode: (error) => (error === primary ? 7 : 9),
          setExitCode: (code) => exitCodes.push(code),
          formatError: (failure) =>
            formatBugReport({
              ...failure,
              context: { commandId: "app:start", cacheRoot: "/cache" },
              rendererMode,
            }),
        },
      );
      // Then: both failures are visible, the primary owns exit status, and secrets/stacks stay out.
      expect(exitCodes).toEqual([7]);
      const text = io.stderr();
      expect(text).not.toContain("private-rollback-token");
      expect(text).not.toContain("    at ");
      expect(text).not.toContain("code: Error");
      if (rendererMode === "json") {
        expect(JSON.parse(text)).toMatchObject({
          _tag: "message.error",
          code: "StartError",
          body: "Start refused.",
          remediation: "Repair start.",
          additionalErrors: [
            {
              code: "CleanupError",
              body: "Cleanup refused [redacted].",
              remediation: "Repair cleanup [redacted].",
            },
          ],
        });
      } else {
        expect(text).toContain(
          "Start refused.\n  ↳ Repair start.\nAlso failed (CleanupError): Cleanup refused [redacted].\n  ↳ Repair cleanup [redacted].\n",
        );
        expect(text).toContain("code: StartError");
        if (rendererMode === "lando") {
          expect(text).not.toContain("\u001b[2mAlso failed");
          expect(text).toContain("\u001b[2mcode: StartError");
        }
      }
    });
  }

  test.each(["json", "yaml"] as const)(
    "%s envelope preserves both tags and primary exit status",
    async (format) => {
      // Given: a primary failure with ordered peer/cleanup failures and an interruption.
      const primary = new StartError({ message: "Start refused.", remediation: "Repair start." });
      const secondary = new CleanupError({ message: "Cleanup refused.", remediation: "Repair cleanup." });
      const cause = Cause.combine(
        Cause.fail(primary),
        Cause.combine(Cause.interrupt(1), Cause.fail(secondary)),
      );
      const io = createBufferedRendererIO();
      const exitCodes: number[] = [];
      // When: the boundary emits a machine envelope.
      await runWithRendererHandling(Effect.failCause(cause), {
        runtime: Layer.empty,
        rendererMode: "plain",
        resultFormat: format,
        command: "app:start",
        io,
        failureExitCode: (error) => (error === primary ? 7 : 9),
        setExitCode: (code) => exitCodes.push(code),
        formatError: ({ error }) => String(error),
      });
      const envelope = Schema.decodeUnknownSync(CommandResultEnvelope)(
        format === "json" ? JSON.parse(io.stdout()) : Bun.YAML.parse(io.stdout()),
      );
      // Then: the envelope is schema-valid with only the non-interrupt additional failure.
      expect(envelope.error).toEqual({
        _tag: "StartError",
        message: "Start refused.",
        remediation: "Repair start.",
        additionalErrors: [
          { _tag: "CleanupError", role: "peer", message: "Cleanup refused.", remediation: "Repair cleanup." },
        ],
      });
      expect(exitCodes).toEqual([7]);
      expect(io.stderr()).toBe("");
    },
  );
});
