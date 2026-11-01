import { expect, test } from "bun:test";
import { createBufferedRendererIO } from "@lando/renderer/io";
import { ServiceNotReadyError } from "@lando/sdk/errors";
import { Effect, Layer, Schema } from "effect";
import { renderPlainBugReport } from "../../src/cli/bug-report-render.ts";
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

test.each(["json", "yaml"] as const)("%s retains structured listener evidence", async (resultFormat) => {
  const listener = {
    service: "cache",
    port: 6380,
    transport: "tcp",
    basis: "probe-target",
    state: "not-listening",
    listening: [{ address: "0.0.0.0", port: 6379 }],
  } as const;
  const failure = new ServiceNotReadyError({
    message: "Service cache is not ready.",
    app: "readiness-app",
    service: "cache",
    providerId: "lando",
    reason: "healthcheck-failed",
    listener,
    remediation: "Fix binding.\nRetry start.",
  });
  const io = createBufferedRendererIO();
  await runWithRendererHandling(Effect.fail(failure), {
    runtime: Layer.empty,
    command: "app:start",
    rendererMode: "json",
    resultFormat,
    resultSchema: Schema.Struct({}),
    io,
    formatError: ({ error }) => String(error),
    setExitCode: () => {},
  });
  const result = resultFormat === "json" ? JSON.parse(io.stdout()) : Bun.YAML.parse(io.stdout());
  expect(result).toMatchObject({ ok: false, error: { listener } });
  const plain = renderPlainBugReport(
    buildBugReport({ error: failure, context: { commandId: "app:start", cacheRoot: "/tmp/cache" } }),
  );
  expect(plain).toContain("listener: not-listening on 6380 (observed 6379)");
  expect(plain).toContain("  ↳ Fix binding.\n  ↳ Retry start.");
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
      formatError: ({ error }) => String(error),
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
