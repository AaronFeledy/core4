import { expect, test } from "bun:test";
import { makeTestRuntime } from "@lando/core/testing";
import { createBufferedRendererIO } from "@lando/renderer/io";
import { ExecAppResult, StreamFrame } from "@lando/sdk/schema";
import { AppPlanner } from "@lando/sdk/services";
import { TestRuntimeProvider } from "@lando/sdk/test";
import { Effect, Schema, Stream } from "effect";
import { execSpec } from "../../src/cli/command-specs/app/exec.ts";
import { compiledCommandInputFromArgv } from "../../src/cli/compiled-input.ts";
import { compiledCommandTransportOptions } from "../../src/cli/compiled-runtime.ts";
import { runWithRendererHandling } from "../../src/cli/renderer-boundary.ts";
import { compiledCommandOptionsFromSpec } from "../../src/cli/run-built-in-command.ts";
import { makePlan } from "../_support/host-proxy-open-fixtures.ts";
import { currentTestPlan } from "../_support/value-contracts.ts";

test("exec NDJSON preserves output but ends in a tagged failure when the provider reports no exit", async () => {
  let dispatches = 0;
  const runtime = makeTestRuntime({
    bootstrap: "app",
    with: {
      RuntimeProvider: {
        ...TestRuntimeProvider,
        execStream: () => {
          dispatches += 1;
          return Stream.make({ kind: "stdout", chunk: new TextEncoder().encode("partial output") });
        },
      },
    },
  });
  const resultFormat = "ndjson";
  const rendererMode = "plain";
  const input = compiledCommandInputFromArgv("app:exec", [`--format=${resultFormat}`, "--", "private-argv"], {
    rendererMode,
  });
  const plan = currentTestPlan(makePlan([], ["appserver"]));
  const operation = execSpec
    .run(input)
    .pipe(Effect.provideService(AppPlanner, AppPlanner.of({ plan: () => Effect.succeed(plan) })));
  const io = createBufferedRendererIO();
  const cliStatuses: number[] = [];
  const options = compiledCommandOptionsFromSpec(execSpec, input);

  await runWithRendererHandling(operation, {
    runtime: runtime.layer,
    rendererMode,
    resultFormat,
    command: execSpec.id,
    resultSchema: ExecAppResult,
    ...options,
    ...compiledCommandTransportOptions(execSpec, options.streamingMode),
    io,
    render: () => undefined,
    formatError: ({ error }) => String(error),
    setExitCode: (code) => {
      cliStatuses.push(code);
    },
  });

  const frames = io.stdoutLines().map((line) => Schema.decodeUnknownSync(StreamFrame)(JSON.parse(line)));
  const terminal = frames.at(-1);
  if (terminal?._tag !== "result") throw new TypeError("missing terminal result frame");
  expect(terminal.envelope).toMatchObject({
    ok: false,
    error: { _tag: "ServiceExecError", service: "appserver" },
  });
  expect(terminal.envelope).not.toHaveProperty("result");
  expect(terminal.envelope.error).not.toHaveProperty("exitCode");
  expect(JSON.stringify(terminal.envelope)).not.toContain("private-argv");
  expect(frames.filter((frame) => frame._tag !== "event").map((frame) => frame._tag)).toEqual([
    "stdout",
    "result",
  ]);
  expect(frames.find((frame) => frame._tag === "stdout")).toMatchObject({ chunk: "partial output" });
  expect(cliStatuses).toEqual([1]);
  expect(dispatches).toBe(1);
});
