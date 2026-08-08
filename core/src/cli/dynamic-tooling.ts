import { Effect, Layer, Schema } from "effect";

import { type CacheError, ToolingCompileError, ToolingExecError } from "@lando/sdk/errors";

import { type RunToolingResult, runTooling } from "@lando/engine/operations/tooling";
import { runBunShellTooling } from "@lando/engine/operations/tooling-bun-script";
import { cliRuntimeOptions } from "@lando/engine/runtime/cli-options";
import { makeLandoRuntime } from "../runtime/layer";
import { renderRunToolingResult } from "./commands/tooling";
import { resetActiveCommandInvocation, runCompiledCommand, setActiveCommandId } from "./compiled-runtime";
import { escapeDiagnosticText } from "./diagnostic-text";
import { resolveToolingRoute, toolingName, toolingRouteError } from "./tooling-router";

const ToolingResultSchema = Schema.Struct({
  tool: Schema.String,
  service: Schema.String,
  exitCode: Schema.Number,
  stdout: Schema.String,
  stderr: Schema.String,
  rendered: Schema.optional(Schema.Boolean),
});

const dynamicToolingOptions = {
  renderEvents: true,
  plainTaskEvents: "detail-only",
  resultSchema: ToolingResultSchema,
  successExitCode: (result: RunToolingResult) => result.exitCode,
  failureExitCode: (error: unknown) => (error instanceof ToolingExecError ? error.exitCode : undefined),
} as const;

const prepareDynamicToolingInvocation = (name: string, argv: ReadonlyArray<string>): void => {
  const commandId = `app:${name}`;
  setActiveCommandId(commandId);
  resetActiveCommandInvocation(commandId, argv);
};

export const runDynamicTooling = (argv: ReadonlyArray<string>): Promise<void> => {
  const name = argv[0];
  if (name === undefined) throw new Error("Missing tooling command name");
  const commandArgv = argv.slice(1);
  prepareDynamicToolingInvocation(name, commandArgv);
  return runCompiledCommand(
    runTooling({ name, args: commandArgv, renderProgress: true }),
    makeLandoRuntime(
      cliRuntimeOptions({
        bootstrap: "app",
        plugins: { policy: "discovery" },
      }),
    ),
    renderRunToolingResult,
    dynamicToolingOptions,
  );
};

export const runDynamicBunShellTooling = (
  name: string,
  argv: ReadonlyArray<string>,
  appRoot: string,
): Promise<void> => {
  prepareDynamicToolingInvocation(name, argv);
  const effect = runBunShellTooling({ name, renderProgress: true }, appRoot).pipe(
    Effect.flatMap((result) =>
      result === undefined
        ? Effect.fail(
            new ToolingCompileError({
              message: `Cached script-backed tooling command app:${escapeDiagnosticText(name)} is no longer available.`,
              tool: name,
              remediation: "Run `lando app:cache:refresh` and retry the command.",
            }),
          )
        : Effect.succeed(result),
    ),
  );
  return runCompiledCommand(
    effect,
    makeLandoRuntime(
      cliRuntimeOptions({
        bootstrap: "minimal",
        plugins: { policy: "discovery" },
      }),
    ),
    renderRunToolingResult,
    dynamicToolingOptions,
  );
};

export const runDynamicToolingFailure = (
  name: string,
  argv: ReadonlyArray<string>,
  error: ToolingCompileError | CacheError,
): Promise<void> => {
  prepareDynamicToolingInvocation(name, argv);
  return runCompiledCommand(Effect.fail(error), Layer.empty, () => undefined, dynamicToolingOptions);
};

export const routeDynamicTooling = async (argv: ReadonlyArray<string>): Promise<boolean> => {
  const token = argv[0];
  if (token === undefined) return false;
  const name = toolingName(token);
  if (name === undefined) return false;

  const resolution = await Effect.runPromise(Effect.either(resolveToolingRoute({ argv })));
  if (resolution._tag === "Left") {
    await runDynamicToolingFailure(name, argv.slice(1), resolution.left);
    return true;
  }

  const route = resolution.right;
  switch (route._tag) {
    case "not-tooling":
      return false;
    case "cache-miss":
    case "unknown-tooling":
      await runDynamicToolingFailure(route.name, route.argv, toolingRouteError(route));
      return true;
    case "bun-script":
      await runDynamicBunShellTooling(route.name, route.argv, route.appRoot);
      return true;
    case "tooling":
      await runDynamicTooling([route.name, ...route.argv]);
      return true;
  }
};
