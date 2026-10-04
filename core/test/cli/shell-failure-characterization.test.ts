import { describe, expect, test } from "bun:test";
import { createBufferedRendererIO } from "@lando/core/testing";
import { Layer } from "effect";
import { formatBugReport } from "../../src/cli/bug-report";
import { runWithRendererHandling } from "../../src/cli/renderer-boundary";
import { shellFailureCases } from "../_support/shell-failure-characterization";
import { makeRecordingHarness } from "./pre-command-failure-fixture";

describe("native shell failure characterization", () => {
  for (const scenario of shellFailureCases) {
    for (const format of ["text", "json"] as const) {
      test(`renders ${scenario.kind} with ${format} and exits 1`, async () => {
        // Given: the same lifecycle and renderer boundary used by native dispatch.
        const io = createBufferedRendererIO();
        const harness = makeRecordingHarness();
        const exitCodes: number[] = [];

        // When
        await runWithRendererHandling(scenario.effect(), {
          runtime: harness.layer,
          rendererMode: "plain",
          resultFormat: format,
          command: "meta:characterize",
          invocation: {
            commandId: "meta:characterize",
            argv: [],
            args: {},
            flags: {},
            cwd: "/workspace",
          },
          io,
          formatError: (error) =>
            formatBugReport({
              error,
              context: { commandId: "meta:characterize", cacheRoot: "/cache" },
              rendererMode: "plain",
            }),
          setExitCode: (code) => exitCodes.push(code),
        });

        // Then: combined failures currently render only their first typed failure.
        expect(exitCodes).toEqual([1]);
        expect(harness.events.map((event) => event._tag)).toEqual([
          "cli-meta:characterize-init",
          "cli-meta:characterize-error",
        ]);
        expect(harness.events.at(-1)).toMatchObject({ failureTag: scenario.failureTag, exitCode: 1 });
        if (format === "text") {
          expect(io.stdout()).toBe("");
          expect(io.stderr()).toBe(
            `${scenario.text}\ncommandId: meta:characterize\nlogsDir: /cache/logs\ncacheDir: /cache\n`,
          );
        } else {
          expect(io.stderr()).toBe("");
          expect(JSON.parse(io.stdout())).toEqual({
            apiVersion: "v4",
            command: "meta:characterize",
            ok: false,
            error: scenario.error,
            warnings: [],
            deprecations: [],
          });
        }
      });
    }
  }

  test("suppressed interruption produces no output or exit-code write", async () => {
    // Given
    const io = createBufferedRendererIO();
    const exitCodes: number[] = [];
    // When
    await runWithRendererHandling(shellFailureCases[2].effect(), {
      runtime: Layer.empty,
      rendererMode: "plain",
      io,
      suppressInterruptionDiagnostics: true,
      formatError: String,
      setExitCode: (code) => exitCodes.push(code),
    });
    // Then
    expect({ stdout: io.stdout(), stderr: io.stderr(), exitCodes }).toEqual({
      stdout: "",
      stderr: "",
      exitCodes: [],
    });
  });
});
