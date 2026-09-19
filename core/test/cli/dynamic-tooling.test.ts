import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { Schema } from "effect";

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
    mock.module(${JSON.stringify(resolve(cliRoot, "spec/command-boundary.ts"))}, () => ({ renderPreCommandFailure: () => {} }));
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
    mock.module(${JSON.stringify(resolve(cliRoot, "exec-host-io.ts"))}, () => ({
      attachedHostTerminal: () => { terminalCalls++; return { term: "xterm-test" }; },
    }));
    mock.module(${JSON.stringify(resolve(cliRoot, "compiled-runtime.ts"))}, () => ({
      activeRendererMode: "plain",
      activeResultFormat: ${JSON.stringify(format)},
      emitJsonListModeIfRequested: () => false,
      resetActiveCommandInvocation: () => {},
      setActiveCommandId: () => {},
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
        invocation: Schema.Struct({ tty: Schema.Boolean, hostTerminal: Schema.optional(Schema.Unknown) }),
        options: Schema.Struct({ streamingMode: Schema.optional(Schema.String) }),
      }),
    )(JSON.parse(stdout));
    expect(observed).toEqual({ terminalCalls: 0, invocation: { tty: false }, options: {} });
  },
);
