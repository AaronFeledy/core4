import { expect, test } from "bun:test";
import { createBufferedRendererIO } from "@lando/renderer/io";
import { ServiceNotReadyError } from "@lando/sdk/errors";
import { Effect, Layer, Schema } from "effect";
import { buildBugReport } from "../../src/cli/bug-report.ts";
import { runWithRendererHandling } from "../../src/cli/renderer-boundary.ts";

const error = new ServiceNotReadyError({
  message: "Service database exited.",
  app: "readiness-app",
  service: "database",
  providerId: "lando",
  reason: "not-running",
  exitCode: 17,
  state: "stopped",
  remediation: "Run `lando logs -s database`, fix the service, then retry `lando start`.",
  logTail: { service: "database", lines: ["fatal startup problem"], truncated: false, exitCode: 17 },
});

test.each(["app:start", "app:restart", "app:rebuild", "meta:global:start"])(
  "%s emits a tagged machine failure and non-zero exit for readiness",
  async (command) => {
    const io = createBufferedRendererIO();
    let exitCode = 0;
    await runWithRendererHandling(Effect.fail(error), {
      runtime: Layer.empty,
      command,
      rendererMode: "json",
      resultFormat: "json",
      resultSchema: Schema.Struct({}),
      io,
      formatError: String,
      setExitCode: (code) => {
        exitCode = code;
      },
    });
    expect(exitCode).toBe(1);
    expect(JSON.parse(io.stdout())).toMatchObject({
      ok: false,
      error: {
        _tag: "ServiceNotReadyError",
        service: "database",
        reason: "not-running",
        exitCode: 17,
        logTail: { lines: ["fatal startup problem"] },
      },
    });
    expect(io.stderr()).toBe("");
  },
);

test("human diagnostics include the readiness log tail and container exit code", () => {
  const report = buildBugReport({
    error,
    context: { commandId: "app:start", cacheRoot: "/tmp/readiness-cache" },
  });
  expect(report.extra).toEqual(
    expect.arrayContaining([
      ["service", "database"],
      ["exitCode", "17"],
      ["logTail (database, exit 17)", "fatal startup problem"],
    ]),
  );
});
