import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { Schema } from "effect";

test.each([
  { readsRouteFacts: true, bootstrap: "app" },
  { readsRouteFacts: false, bootstrap: "minimal" },
] as const)("script route facts choose the $bootstrap tier for %j", async (scenario) => {
  // Given: isolate module mocks from other CLI tests in a fresh process.
  const cliRoot = resolve(import.meta.dirname, "../../src/cli");
  const routeFactFlag = scenario.readsRouteFacts ? "readsRouteFacts: true," : "";
  const script = `
    import { mock } from "bun:test";
    import { Effect, Layer, Result } from "effect";
    let bootstrap;
    let invocation;
    mock.module(${JSON.stringify(resolve(cliRoot, "./spec/command-boundary.ts"))}, () => ({ renderPreCommandFailure: () => {} }));
    mock.module(${JSON.stringify(resolve(cliRoot, "tooling-router.ts"))}, () => ({
      resolveToolingRoute: () => Effect.void,
      toolingName: (name) => name,
      toolingRouteError: () => undefined,
    }));
    mock.module("@lando/engine/operations/tooling", () => ({
      runTooling: () => Effect.void,
      runToolingRedactionTokens: () => [],
    }));
    mock.module("@lando/engine/operations/tooling-bun-script", () => ({
      runBunShellTooling: (options) => {
        invocation = { plan: options.plan === undefined ? "resolved" : "caller", input: options.input };
        return Effect.succeed({ tool: "app:smoke", service: ":host", exitCode: 0, stdout: "", stderr: "" });
      },
    }));
    mock.module(${JSON.stringify(resolve(cliRoot, "../runtime/layer.ts"))}, () => ({
      makeLandoRuntime: (options) => { bootstrap = options.bootstrap; return Layer.empty; },
    }));
    mock.module(${JSON.stringify(resolve(cliRoot, "compiled-runtime.ts"))}, () => ({
      activeRendererMode: "plain",
      activeResultFormat: "text",
      activeJq: undefined,
      activeJsonControl: { mode: "off" },
      emitJsonListModeIfRequested: () => false,
      resetActiveCommandInvocation: () => {},
      setActiveCommandId: () => {},
      runWithProcessAbortSignal: (run) => run(new AbortController().signal),
      runCompiledCommand: async (effect) => { await Effect.runPromise(effect); },
    }));
    const { routeResolvedTooling } = await import(${JSON.stringify(resolve(cliRoot, "dynamic-tooling.ts"))});
    const { normalizeToolingInput } = await import("@lando/landofile/tooling-input-normalize");
    const input = Result.getOrThrow(normalizeToolingInput("smoke", {}));
    await routeResolvedTooling({
      _tag: "bun-script",
      name: "smoke",
      appRoot: "/app",
      availability: { _tag: "Ready", input, ${routeFactFlag} },
    }, []);
    console.log(JSON.stringify({ bootstrap, invocation }));
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
  expect(
    Schema.decodeUnknownSync(
      Schema.Struct({
        bootstrap: Schema.String,
        invocation: Schema.Struct({ plan: Schema.String, input: Schema.Unknown }),
      }),
    )(JSON.parse(stdout)),
  ).toEqual({
    bootstrap: scenario.bootstrap,
    invocation: { plan: "resolved", input: { _tag: "RawArgv", argv: [] } },
  });
});
