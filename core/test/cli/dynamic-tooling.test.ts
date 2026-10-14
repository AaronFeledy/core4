import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { Schema } from "effect";

test.each([
  { stdinTTY: true, stdoutTTY: true, renderer: "lando", format: "text", hostIo: "terminal", progress: false },
  { stdinTTY: true, stdoutTTY: false, renderer: "lando", format: "text", hostIo: undefined, progress: true },
  { stdinTTY: false, stdoutTTY: false, renderer: "lando", format: "text", hostIo: "stdin", progress: true },
  { stdinTTY: true, stdoutTTY: true, renderer: "json", format: "text", hostIo: undefined, progress: true },
  { stdinTTY: false, stdoutTTY: true, renderer: "json", format: "text", hostIo: "stdin", progress: true },
  { stdinTTY: true, stdoutTTY: true, renderer: "lando", format: "json", hostIo: undefined, progress: true },
  { stdinTTY: false, stdoutTTY: true, renderer: "lando", format: "json", hostIo: "stdin", progress: true },
  { stdinTTY: true, stdoutTTY: true, renderer: "lando", format: "yaml", hostIo: undefined, progress: true },
  { stdinTTY: false, stdoutTTY: true, renderer: "lando", format: "yaml", hostIo: "stdin", progress: true },
])("script tooling host wiring %j", async (scenario) => {
  // Given
  const cliRoot = resolve(import.meta.dirname, "../../src/cli");
  const script = `
    import { mock } from "bun:test";
    import { Effect, Layer } from "effect";
    const scenario = ${JSON.stringify(scenario)};
    const controller = new AbortController();
    let observed;
    mock.module(${JSON.stringify(resolve(cliRoot, "./spec/command-boundary.ts"))}, () => ({ renderPreCommandFailure: () => {} }));
    mock.module(${JSON.stringify(resolve(cliRoot, "tooling-router.ts"))}, () => ({ resolveToolingRoute: () => Effect.void, toolingName: name => name, toolingRouteError: () => undefined }));
    mock.module("@lando/engine/operations/tooling", () => ({ runTooling: () => Effect.void, runToolingRedactionTokens: () => [] }));
    const io = await import(${JSON.stringify(resolve(cliRoot, "exec-host-io.ts"))});
    const { toolingHostStdin } = io;
    mock.module(${JSON.stringify(resolve(cliRoot, "exec-host-io.ts"))}, () => ({
      ...io,
      toolingHostStdin: enabled => toolingHostStdin(enabled, { isTTY: scenario.stdinTTY }, { isTTY: scenario.stdoutTTY }),
    }));
    mock.module("@lando/engine/operations/tooling-bun-script", () => ({
      runBunShellTooling: (options, root) => Effect.sync(() => {
        observed = { hostIo: options.hostIo, progress: options.renderProgress,
          signal: options.signal === controller.signal, args: options.args, root };
        return { tool: "app:scount", service: ":host", exitCode: 0, stdout: "", stderr: "" };
      }),
    }));
    mock.module(${JSON.stringify(resolve(cliRoot, "../runtime/layer.ts"))}, () => ({ makeLandoRuntime: () => Layer.empty }));
    mock.module(${JSON.stringify(resolve(cliRoot, "compiled-runtime.ts"))}, () => ({
      activeRendererMode: scenario.renderer, activeResultFormat: scenario.format, activeJq: undefined,
      activeJsonControl: { mode: "off" }, emitJsonListModeIfRequested: () => false,
      resetActiveCommandInvocation: () => {}, setActiveCommandId: () => {},
      runWithProcessAbortSignal: run => run(controller.signal),
      runCompiledCommand: async effect => { await Effect.runPromise(effect); },
    }));
    const { routeResolvedTooling } = await import(${JSON.stringify(resolve(cliRoot, "dynamic-tooling.ts"))});
    await routeResolvedTooling({ _tag: "bun-script", name: "scount", appRoot: "/app", relativePath: "scount.bun.sh" }, ["--", "argument"]);
    console.log(JSON.stringify(observed));
  `;
  // When
  const child = Bun.spawn([process.execPath, "-e", script], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  // Then
  expect(code, stderr).toBe(0);
  expect(JSON.parse(stdout)).toEqual({
    ...(scenario.hostIo === undefined ? {} : { hostIo: scenario.hostIo }),
    progress: scenario.progress,
    signal: true,
    args: ["argument"],
    root: "/app",
  });
});

test.each(["json", "yaml"])(
  "%s dynamic tooling buffers output without attaching a host terminal",
  async (format) => {
    // Given: isolate module mocks from other CLI tests in a fresh process.
    const cliRoot = resolve(import.meta.dirname, "../../src/cli");
    const script = `
    import { mock } from "bun:test";
    import { Effect, Layer } from "effect";
    let terminalCalls = 0;
    let invocation;
    mock.module(${JSON.stringify(resolve(cliRoot, "./spec/command-boundary.ts"))}, () => ({ renderPreCommandFailure: () => {} }));
    mock.module(${JSON.stringify(resolve(cliRoot, "tooling-router.ts"))}, () => ({
      resolveToolingRoute: () => Effect.void,
      toolingName: (name) => name,
      toolingRouteError: () => undefined,
    }));
    mock.module("@lando/engine/operations/tooling", () => ({
      runTooling: (options) => { invocation = options; return Effect.void; },
      runToolingRedactionTokens: () => [],
    }));
    mock.module(${JSON.stringify(resolve(cliRoot, "../runtime/layer.ts"))}, () => ({ makeLandoRuntime: () => Layer.empty }));
    const hostIo = await import(${JSON.stringify(resolve(cliRoot, "exec-host-io.ts"))});
    mock.module(${JSON.stringify(resolve(cliRoot, "exec-host-io.ts"))}, () => ({
      ...hostIo,
      attachToolingHostIo: (enabled) => { if (enabled) terminalCalls++; return { tty: false }; },
    }));
    mock.module(${JSON.stringify(resolve(cliRoot, "compiled-runtime.ts"))}, () => ({
      activeRendererMode: "plain",
      activeResultFormat: ${JSON.stringify(format)},
      activeJq: undefined,
      activeJsonControl: { mode: "off" },
      emitJsonListModeIfRequested: () => false,
      resetActiveCommandInvocation: () => {},
      setActiveCommandId: () => {},
      runWithProcessAbortSignal: (run) => run(new AbortController().signal),
      runCompiledCommand: async (_effect, _runtime, _render, options) => {
        console.log(JSON.stringify({ terminalCalls, invocation, options }));
      },
    }));
    const { runDynamicTooling } = await import(${JSON.stringify(resolve(cliRoot, "dynamic-tooling.ts"))});
    await runDynamicTooling(["test-tool", "argument"]);
  `;
    // When
    const child = Bun.spawn([process.execPath, "-e", script], { stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    // Then
    expect(code, stderr).toBe(0);
    expect(stderr).toBe("");
    const observed = Schema.decodeUnknownSync(
      Schema.Struct({
        terminalCalls: Schema.Number,
        invocation: Schema.Struct({ tty: Schema.Boolean, hostTerminal: Schema.optionalKey(Schema.Unknown) }),
        options: Schema.Struct({ streamingMode: Schema.optionalKey(Schema.String) }),
      }),
    )(JSON.parse(stdout));
    expect(observed).toEqual({ terminalCalls: 0, invocation: { tty: false }, options: {} });
  },
);

test.each([
  { stdinTTY: true, stdoutTTY: true, renderer: "lando", format: "text", fail: false, interactive: true },
  { stdinTTY: true, stdoutTTY: true, renderer: "lando", format: "text", fail: true, interactive: true },
  {
    stdinTTY: true,
    stdoutTTY: true,
    renderer: "lando",
    format: "text",
    fail: false,
    interactive: true,
    hostOnly: true,
  },
  { stdinTTY: false, stdoutTTY: true, renderer: "lando", format: "text", fail: false, interactive: false },
  { stdinTTY: false, stdoutTTY: false, renderer: "lando", format: "text", fail: false, interactive: false },
  { stdinTTY: false, stdoutTTY: true, renderer: "json", format: "text", fail: false, interactive: false },
  { stdinTTY: false, stdoutTTY: true, renderer: "lando", format: "json", fail: false, interactive: false },
  { stdinTTY: true, stdoutTTY: false, renderer: "lando", format: "text", fail: false, interactive: false },
  { stdinTTY: true, stdoutTTY: true, renderer: "json", format: "text", fail: false, interactive: false },
  { stdinTTY: true, stdoutTTY: true, renderer: "lando", format: "json", fail: false, interactive: false },
])("dynamic tooling terminal wiring %j", async (scenario) => {
  // Given
  const cliRoot = resolve(import.meta.dirname, "../../src/cli");
  const script = `
    import { mock } from "bun:test";
    import { PassThrough } from "node:stream";
    import { Effect, Layer } from "effect";
    const scenario = ${JSON.stringify(scenario)};
    let raw = false;
    let observed;
    const input = Object.assign(new PassThrough(), { isTTY: scenario.stdinTTY, setRawMode: (value) => { raw = value; } });
    Object.defineProperty(input, "isRaw", { get: () => raw });
    const io = await import(${JSON.stringify(resolve(cliRoot, "exec-host-io.ts"))});
    const { attachToolingHostIo } = io;
    mock.module(${JSON.stringify(resolve(cliRoot, "exec-host-io.ts"))}, () => ({
      ...io,
      attachToolingHostIo: (enabled) => attachToolingHostIo(enabled, input, { isTTY: scenario.stdoutTTY, columns: 140, rows: 35 }),
    }));
    mock.module(${JSON.stringify(resolve(cliRoot, "tooling-router.ts"))}, () => ({ resolveToolingRoute: () => Effect.void, toolingName: (name) => name, toolingRouteError: () => undefined }));
    mock.module(${JSON.stringify(resolve(cliRoot, "./spec/command-boundary.ts"))}, () => ({ renderPreCommandFailure: () => {} }));
    mock.module("@lando/engine/operations/tooling", () => ({
      runTooling: (options) => Effect.suspend(() => {
        const rawBefore = raw;
        const reader = scenario.hostOnly ? undefined : options.stdinStream?.[Symbol.asyncIterator]();
        observed = { rawBefore, rawDuring: raw, tty: options.tty, keyboard: options.stdinStream !== undefined, resize: options.terminalResize !== undefined, signal: options.signal instanceof AbortSignal, progress: options.renderProgress };
        return scenario.fail ? Effect.fail("failed") : Effect.promise(async () => { await reader?.return?.(); });
      }),
      runToolingRedactionTokens: () => [],
    }));
    mock.module(${JSON.stringify(resolve(cliRoot, "../runtime/layer.ts"))}, () => ({ makeLandoRuntime: () => Layer.empty }));
    mock.module(${JSON.stringify(resolve(cliRoot, "compiled-runtime.ts"))}, () => ({
      activeRendererMode: scenario.renderer, activeResultFormat: scenario.format, activeJq: undefined,
      activeJsonControl: { mode: "off" }, emitJsonListModeIfRequested: () => false,
      resetActiveCommandInvocation: () => {}, setActiveCommandId: () => {},
      runWithProcessAbortSignal: (run) => run(new AbortController().signal),
      runCompiledCommand: async (effect, _runtime, _render, options) => {
        await Effect.runPromise(Effect.result(effect));
        observed.streaming = options.streamingMode === "live";
      },
    }));
    const { runDynamicTooling } = await import(${JSON.stringify(resolve(cliRoot, "dynamic-tooling.ts"))});
    await runDynamicTooling(["test-tool"]);
    console.log(JSON.stringify({ ...observed, rawAfter: raw }));
    input.destroy();
  `;
  // When
  const child = Bun.spawn([process.execPath, "-e", script], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  // Then
  expect(code, stderr).toBe(0);
  expect(JSON.parse(stdout)).toEqual({
    rawBefore: false,
    rawDuring: scenario.interactive && !("hostOnly" in scenario && scenario.hostOnly),
    rawAfter: false,
    tty: scenario.interactive,
    keyboard: !scenario.stdinTTY || scenario.interactive,
    resize: scenario.interactive,
    signal: true,
    progress: !scenario.interactive,
    streaming: scenario.format !== "json",
  });
});
