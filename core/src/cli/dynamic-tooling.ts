import { commandCompletionFromExitCode } from "@lando/sdk/command-result";
import { type ToolingInputDeclaration, ToolingResult } from "@lando/sdk/schema";
import { Effect, Layer } from "effect";

import {
  type BunShellScriptEmptyError,
  type BunShellScriptFrontMatterError,
  type CacheError,
  type CommandAliasConflictError,
  type CommandAliasTargetError,
  type LandofileFormConflictError,
  type NotImplementedError,
  type ToolingCommandUnavailableError,
  ToolingCompileError,
  ToolingExecError,
} from "@lando/sdk/errors";

import {
  type RunToolingResult,
  runTooling,
  runToolingRedactionTokens,
} from "@lando/engine/operations/tooling";
import { runBunShellTooling } from "@lando/engine/operations/tooling-bun-script";
import { cliRuntimeOptions } from "@lando/engine/runtime/cli-options";
import { isStdioRendererIO } from "@lando/renderer/io";
import type { CliInvocationContext } from "../runtime/invocation-context";
import { makeLandoRuntime } from "../runtime/layer";
import { finishCommandProgress } from "./command-progress";
import { renderRunToolingResult } from "./commands/tooling";
import {
  activeRendererMode,
  activeResultFormat,
  emitJsonListModeIfRequested,
  resetActiveCommandInvocation,
  runCompiledCommand,
  runWithProcessAbortSignal,
  setActiveCommandId,
} from "./compiled-runtime";
import { escapeDiagnosticText } from "./diagnostic-text";
import { attachToolingHostIo, toolingHostStdin } from "./exec-host-io";
import { isEnvelopeResultFormat } from "./format-flags";
import { rejectUnsupportedResultFormat } from "./result-format-guard";
import { renderPreCommandFailure } from "./spec/command-boundary";
import { type ToolingRoute, toolingRouteError } from "./tooling-router";

const dynamicToolingOptions = {
  resultSchema: ToolingResult,
  redactionTokens: runToolingRedactionTokens,
  completion: (result: RunToolingResult) => commandCompletionFromExitCode(result.exitCode),
  failureExitCode: (error: unknown) => {
    if (!(error instanceof ToolingExecError)) return undefined;
    return error.variable === undefined ? error.exitCode : 1;
  },
} as const;

/** Retire event rendering before a keyboard-attached PTY so the tree does not fight the session. */
const withKeyboardHandoff = <A, E, R>(
  handoff: boolean,
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  handoff
    ? Effect.gen(function* () {
        yield* finishCommandProgress();
        return yield* effect;
      })
    : effect;

/** Live sinks only for human formats; envelope formats collect into the result document. */
const dynamicToolingStreaming = (): { readonly streamingMode?: "live" } =>
  isEnvelopeResultFormat(activeResultFormat) ? {} : { streamingMode: "live" };

const assertNever = (value: never): never => value;

const prepareDynamicToolingInvocation = (name: string, context?: CliInvocationContext): void => {
  const commandId = `app:${name}`;
  setActiveCommandId(commandId);
  resetActiveCommandInvocation(commandId, [], { ...(context === undefined ? {} : { context }) });
};

export const runDynamicTooling = async (
  argv: ReadonlyArray<string>,
  parentSignal?: AbortSignal,
  declaration?: ToolingInputDeclaration,
  context?: CliInvocationContext,
): Promise<void> => {
  if (parentSignal?.aborted) return;
  const name = argv[0];
  if (name === undefined) throw new Error("Missing tooling command name");
  const taskArgv = argv.slice(1);
  // The first separator belongs to Lando; subsequent separators belong to the task.
  const commandArgv = taskArgv[0] === "--" ? taskArgv.slice(1) : taskArgv;
  prepareDynamicToolingInvocation(name, context);
  if (await emitJsonListModeIfRequested(ToolingResult, context)) return;
  const { restore, ...hostIo } =
    context !== undefined && !isStdioRendererIO(context.io)
      ? {
          tty: false,
          ...(context.io.stdin === undefined ? {} : { stdinStream: context.io.stdin }),
          restore: () => {},
        }
      : attachToolingHostIo(!isEnvelopeResultFormat(activeResultFormat) && activeRendererMode !== "json");
  const interactive = hostIo.tty === true;
  return runWithProcessAbortSignal(
    (signal) =>
      runCompiledCommand(
        withKeyboardHandoff(
          interactive,
          runTooling({
            name,
            input: { _tag: "RawArgv", argv: commandArgv },
            ...(declaration === undefined ? {} : { expectedInputRevision: declaration.revision }),
            ...hostIo,
            signal,
          }),
        ),
        makeLandoRuntime(
          cliRuntimeOptions({
            bootstrap: "app",
            plugins: { policy: "discovery" },
          }),
        ),
        renderRunToolingResult,
        {
          ...dynamicToolingOptions,
          ...(context === undefined ? {} : { context }),
          signal,
          ...dynamicToolingStreaming(),
        },
      ),
    parentSignal === undefined ? {} : { signal: parentSignal },
  ).finally(restore);
};

const runDynamicBunShellTooling = async (
  route: Extract<ToolingRoute, { readonly _tag: "bun-script" }>,
  argv: ReadonlyArray<string>,
  parentSignal?: AbortSignal,
  context?: CliInvocationContext,
): Promise<void> => {
  if (parentSignal?.aborted) return;
  const { name, appRoot, relativePath, input } = route;
  const commandArgv = argv[0] === "--" ? argv.slice(1) : argv;
  prepareDynamicToolingInvocation(name, context);
  if (await emitJsonListModeIfRequested(ToolingResult, context)) return;
  const mode =
    context === undefined || isStdioRendererIO(context.io)
      ? toolingHostStdin(!isEnvelopeResultFormat(activeResultFormat) && activeRendererMode !== "json")
      : context.io.stdin === undefined
        ? "none"
        : "piped";
  return runWithProcessAbortSignal(
    (signal) => {
      const effect = withKeyboardHandoff(
        mode === "keyboard",
        runBunShellTooling(
          {
            name,
            input: { _tag: "RawArgv", argv: commandArgv },
            ...(input === undefined ? {} : { expectedInputRevision: input.revision }),
            ...(mode === "none"
              ? {}
              : { hostIo: mode === "keyboard" ? ("terminal" as const) : ("stdin" as const) }),
            signal,
            relativePath: relativePath ?? `${name.split(":").join("/")}.bun.sh`,
          },
          appRoot,
        ).pipe(
          Effect.flatMap((result) =>
            result === undefined
              ? Effect.fail(
                  new ToolingCompileError({
                    message: `Cached script-backed tooling command app:${escapeDiagnosticText(name)} is no longer available.`,
                    tool: name,
                    remediation: "Retry the command.",
                  }),
                )
              : Effect.succeed(result),
          ),
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
        {
          ...dynamicToolingOptions,
          ...(context === undefined ? {} : { context }),
          signal,
          ...dynamicToolingStreaming(),
        },
      );
    },
    parentSignal === undefined ? {} : { signal: parentSignal },
  );
};

const runDynamicToolingFailure = (
  name: string,
  error:
    | ToolingCompileError
    | ToolingCommandUnavailableError
    | CacheError
    | LandofileFormConflictError
    | CommandAliasConflictError
    | CommandAliasTargetError
    | BunShellScriptEmptyError
    | BunShellScriptFrontMatterError
    | NotImplementedError,
  context?: CliInvocationContext,
): Promise<void> => {
  prepareDynamicToolingInvocation(name, context);
  return runCompiledCommand(Effect.fail(error), Layer.empty, () => undefined, {
    ...dynamicToolingOptions,
    ...(context === undefined ? {} : { context }),
  });
};

export const renderAliasResolutionFailure = async (
  error: unknown,
  context?: CliInvocationContext,
  commandId = "cli:alias-resolution",
): Promise<void> => {
  setActiveCommandId(commandId);
  await renderPreCommandFailure({
    ...(context === undefined ? {} : { context }),
    commandId,
    error,
    rendererMode: activeRendererMode,
    resultFormat: activeResultFormat,
  });
};

export const routeResolvedTooling = async (
  route: ToolingRoute,
  argv: ReadonlyArray<string>,
  signal?: AbortSignal,
  context?: CliInvocationContext,
): Promise<boolean> => {
  if (signal?.aborted) return true;
  switch (route._tag) {
    case "not-tooling":
    case "built-in":
    case "plugin":
    case "alias-disabled":
    case "unknown-tooling":
      return false;
    case "cache-miss":
      if (route.reason === "rebuild-failed") {
        prepareDynamicToolingInvocation(route.name, context);
        await renderPreCommandFailure({
          ...(context === undefined ? {} : { context }),
          commandId: route.commandId,
          error: route.error,
          rendererMode: activeRendererMode,
          resultFormat: activeResultFormat,
        });
      } else await runDynamicToolingFailure(route.name, toolingRouteError(route), context);
      return true;
    case "bun-script":
      await import("../runtime/bundled-plugins");
      // A tooling task renders its own streams and declares no opt-in format.
      if (
        await rejectUnsupportedResultFormat(`app:${route.name}`, undefined, {
          ...(context === undefined ? {} : { context }),
        })
      )
        return true;
      await runDynamicBunShellTooling(route, argv, signal, context);
      return true;
    case "tooling":
      await import("../runtime/bundled-plugins");
      if (
        await rejectUnsupportedResultFormat(`app:${route.name}`, undefined, {
          ...(context === undefined ? {} : { context }),
        })
      )
        return true;
      await runDynamicTooling([route.name, ...argv], signal, route.input, context);
      return true;
    default:
      return assertNever(route);
  }
};
