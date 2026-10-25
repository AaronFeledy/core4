import { expect, test } from "bun:test";
import { createBufferedRendererIO } from "@lando/renderer/io";
import { CommandResultEnvelope } from "@lando/sdk/schema";
import { Cause, Effect, Layer, Schema } from "effect";
import { formatBugReport } from "../../src/cli/bug-report";
import { runWithRendererHandling } from "../../src/cli/renderer-boundary";
import { activeLogLevel, setActiveLogLevel } from "../../src/cli/renderer-mode-state";

for (const stage of ["bootstrap", "body", "formatter", "failure-formatter", "finalizer"] as const) {
  for (const format of ["text", "json"] as const) {
    if (format === "json" && (stage === "formatter" || stage === "failure-formatter")) continue;
    test(`${stage} defect produces one redacted ${format} internal-error report`, async () => {
      const secret = "p2b-private-defect-token";
      const defect = new Error(`Unexpected ${stage}: ${secret}\n    at embedded-stack`);
      const io = createBufferedRendererIO();
      const exitCodes: number[] = [];
      const operation =
        stage === "body"
          ? Effect.die(defect)
          : stage === "failure-formatter"
            ? Effect.fail("failed")
            : Effect.succeed("done");
      const runtime =
        stage === "bootstrap"
          ? Layer.effectDiscard(Effect.die(defect))
          : stage === "finalizer"
            ? Layer.effectDiscard(Effect.addFinalizer(() => Effect.die(defect)))
            : Layer.empty;

      await runWithRendererHandling(operation, {
        runtime,
        command: "app:info",
        rendererMode: "plain",
        resultFormat: format,
        resultSchema: Schema.String,
        sourceEnv: { API_TOKEN: secret },
        io,
        setExitCode: (code) => exitCodes.push(code),
        failureExitCode: () => 7,
        render: () => {
          throw defect;
        },
        formatError: (failure, redactor) => {
          if (stage === "failure-formatter") throw defect;
          return formatBugReport({
            ...failure,
            context: { commandId: "app:info" },
            rendererMode: "plain",
            redactor,
          });
        },
      });

      expect(exitCodes).toEqual([1]);
      const output = io.stdout() + io.stderr();
      expect(output).not.toContain(secret);
      expect(output).not.toMatch(/\n\s+at /u);
      expect(output).not.toContain("embedded-stack");
      if (format === "json") {
        expect(io.stderr()).toBe("");
        const envelope = Schema.decodeUnknownSync(CommandResultEnvelope)(JSON.parse(io.stdout()));
        expect(envelope).toMatchObject({ ok: false, error: { _tag: "LandoInternalError" } });
        expect(envelope.error?.remediation).toContain("--debug");
      } else {
        expect(io.stdout()).toBe("");
        expect(output).toContain("code: LandoInternalError");
        expect(output).toContain("--debug");
      }
    });
  }
}

test("tagged defects normalize without changing typed primary and cleanup roles", async () => {
  const { failureOutcomeFromCause } = await import("@lando/sdk/command-result");
  const outcome = failureOutcomeFromCause(Cause.die({ _tag: "NotAUserFailure", message: "crashed" }));
  expect(outcome.error).toMatchObject({ _tag: "LandoInternalError", message: "crashed" });
});

test("debug diagnostics retain the redacted pretty cause in the existing structured stderr channel", async () => {
  const previous = activeLogLevel;
  const io = createBufferedRendererIO();
  const secret = "debug-private-defect-token";
  setActiveLogLevel("debug");
  try {
    await runWithRendererHandling(Effect.die(new Error(`failed ${secret}`)), {
      runtime: Layer.empty,
      command: "app:info",
      rendererMode: "plain",
      resultFormat: "json",
      sourceEnv: { API_TOKEN: secret },
      io,
      setExitCode: () => undefined,
      formatError: () => "unused",
    });
    const records = io
      .stderrLines()
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    expect(records).toHaveLength(1);
    expect(io.stderr()).toContain("Command defect");
    expect(io.stderr()).toContain("failed [redacted]");
    expect(io.stderr()).not.toContain(secret);
    expect(io.stderr()).not.toMatch(/\n\s+at /u);
    expect(Schema.decodeUnknownSync(CommandResultEnvelope)(JSON.parse(io.stdout())).error?._tag).toBe(
      "LandoInternalError",
    );
  } finally {
    setActiveLogLevel(previous);
  }
});
