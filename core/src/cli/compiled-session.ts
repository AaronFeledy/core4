/**
 * Compiled-CLI session state and renderer output helpers.
 *
 * Holds the per-process "active command" session — result format, renderer
 * mode, deprecation-warning toggle, command id, and the current invocation
 * snapshot (including nested-invocation parent linkage) — plus the small
 * renderer-boundary helpers that emit result/diagnostic lines and format bug
 * reports for the active mode. `compiled-runtime.ts` composes this state into
 * command-runtime resolution and execution.
 */
import { Effect } from "effect";

import { type BugReportContext, type RendererMode, formatBugReport } from "./bug-report.ts";
import { type CliInvocationSnapshot, newInvocationId } from "./command-lifecycle.ts";
import { DEFAULT_RESULT_FORMAT, type ResultFormat } from "./format-flags.ts";
import { makeRendererServiceLiveForMode, writeDiagnosticLine, writeResultLine } from "./renderer-boundary.ts";
import { activeRendererMode } from "./renderer-mode-state.ts";

export { activeRendererMode, setActiveRendererMode } from "./renderer-mode-state.ts";

export interface CompiledCommandInput {
  readonly argv: ReadonlyArray<string>;
  readonly flags: Record<string, unknown>;
  readonly args: Record<string, unknown>;
  readonly rendererMode?: RendererMode;
  readonly resultFormat?: ResultFormat;
  readonly signal?: AbortSignal;
}

export let activeResultFormat: ResultFormat = DEFAULT_RESULT_FORMAT;
export let activeDeprecationWarnings = true;
export let activeCommandId = "cli:unknown";
let activeCommandInvocation: CliInvocationSnapshot | undefined;

export const getActiveCommandInvocation = (): CliInvocationSnapshot | undefined => activeCommandInvocation;

export const clearActiveCommandInvocation = (): void => {
  activeCommandInvocation = undefined;
};

export const setActiveResultFormat = (format: ResultFormat): void => {
  activeResultFormat = format;
};

export const setActiveDeprecationWarnings = (enabled: boolean): void => {
  activeDeprecationWarnings = enabled;
};

export const setActiveCommandId = (commandId: string): void => {
  activeCommandId = commandId;
};

export const setActiveCommandInvocation = (
  commandId: string,
  input: Pick<CompiledCommandInput, "argv" | "args" | "flags">,
  options: { readonly parentInvocationId?: string } = {},
): void => {
  const sameCommand = activeCommandInvocation?.commandId === commandId;
  const invocationId =
    sameCommand && activeCommandInvocation?.invocationId !== undefined
      ? activeCommandInvocation.invocationId
      : newInvocationId();
  const parentInvocationId =
    options.parentInvocationId ?? (sameCommand ? activeCommandInvocation?.parentInvocationId : undefined);
  activeCommandInvocation = {
    commandId,
    argv: input.argv,
    args: input.args,
    flags: input.flags,
    cwd: process.cwd(),
    invocationId,
    ...(parentInvocationId === undefined ? {} : { parentInvocationId }),
  };
};

export const resetActiveCommandInvocation = (
  commandId: string,
  argv: ReadonlyArray<string>,
  options: { readonly parentInvocationId?: string } = {},
): void => {
  activeCommandInvocation = {
    commandId,
    argv,
    args: {},
    flags: {},
    cwd: process.cwd(),
    invocationId: newInvocationId(),
    ...(options.parentInvocationId === undefined ? {} : { parentInvocationId: options.parentInvocationId }),
  };
};

export const beginNestedCommandInvocation = (
  commandId: string,
  argv: ReadonlyArray<string>,
): CliInvocationSnapshot => {
  const parentInvocationId = activeCommandInvocation?.invocationId;
  resetActiveCommandInvocation(commandId, argv, {
    ...(parentInvocationId === undefined ? {} : { parentInvocationId }),
  });
  return activeCommandInvocation as CliInvocationSnapshot;
};

export const commandErrorMessage = (error: unknown, commandId: string = activeCommandId): string => {
  const context: BugReportContext = { commandId };
  return formatBugReport({ error, context, rendererMode: activeRendererMode });
};

export const emitResultLine = (text: string): void => {
  Effect.runSync(
    writeResultLine(text).pipe(Effect.provide(makeRendererServiceLiveForMode(activeRendererMode))),
  );
};

export const emitDiagnosticLine = (text: string): void => {
  Effect.runSync(
    writeDiagnosticLine(text).pipe(Effect.provide(makeRendererServiceLiveForMode(activeRendererMode))),
  );
};
