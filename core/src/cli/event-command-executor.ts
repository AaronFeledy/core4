import { Cause, Context, Effect, Layer } from "effect";

import { ToolingCompileError } from "@lando/sdk/errors";
import { RENDERER_CAPABILITIES_NONE } from "@lando/sdk/renderer";
import { Renderer } from "@lando/sdk/services";

import { RuntimeCwd } from "@lando/engine/runtime/cwd";
import { EventCommandExecutor } from "@lando/engine/services/event-command-executor";
import type { EventCommandExecutorInput } from "@lando/engine/services/event-command-executor";
import { withResolvedCwd } from "@lando/landofile/app-resolution";
import type { BuiltInCommandEntry } from "./built-in-command-registry";
import { makeNestedCommandInvocation, runCommandLifecycle } from "./command-lifecycle";
import type { CompiledCommandInput } from "./compiled-runtime";
import { notImplementedErrorForSpec } from "./deferred-commands";
import { DEFAULT_RESULT_FORMAT } from "./format-flags";
import { DEFAULT_RENDERER_MODE, isRendererMode } from "./renderer-selection";

let eventCommandEntries: ReadonlyArray<BuiltInCommandEntry> = [];

export const injectEventCommandRegistry = (entries: ReadonlyArray<BuiltInCommandEntry>): void => {
  eventCommandEntries = entries;
};

const silentRenderer = {
  id: "silent",
  capabilities: RENDERER_CAPABILITIES_NONE,
  message: {
    info: () => Effect.void,
    warn: () => Effect.void,
    error: () => Effect.void,
  },
  output: {
    stdout: () => Effect.void,
    stderr: () => Effect.void,
  },
} satisfies Context.Tag.Service<typeof Renderer>;

const flagDefinitionsForCommand = (entry: BuiltInCommandEntry): Readonly<Record<string, unknown>> => {
  const command = entry.command as {
    readonly baseFlags?: Readonly<Record<string, unknown>>;
    readonly flags?: Readonly<Record<string, unknown>>;
  };
  return { ...(command.baseFlags ?? {}), ...(command.flags ?? {}) };
};

const argDefinitionsForCommand = (entry: BuiltInCommandEntry): Readonly<Record<string, unknown>> =>
  (entry.command as { readonly args?: Readonly<Record<string, unknown>> }).args ?? {};

const compileInput = (input: {
  readonly entry: BuiltInCommandEntry;
  readonly flags: Readonly<Record<string, string | number | boolean>>;
  readonly args: Readonly<Record<string, string | number | boolean>>;
  readonly argv: ReadonlyArray<string>;
  readonly flagDefinitions: Readonly<Record<string, unknown>>;
  readonly argDefinitions: Readonly<Record<string, unknown>>;
}): CompiledCommandInput | ToolingCompileError => {
  const commandId = input.entry.spec.id;
  const unknownFlag = Object.keys(input.flags).find((name) => input.flagDefinitions[name] === undefined);
  if (unknownFlag !== undefined) {
    return new ToolingCompileError({
      message: `Unknown flag ${unknownFlag} for canonical command ${commandId}.`,
      tool: commandId,
      remediation: `Remove ${unknownFlag} or use a flag declared by ${commandId}.`,
    });
  }
  const unknownArg = Object.keys(input.args).find((name) => input.argDefinitions[name] === undefined);
  if (unknownArg !== undefined) {
    return new ToolingCompileError({
      message: `Unknown argument ${unknownArg} for canonical command ${commandId}.`,
      tool: commandId,
      remediation: `Remove ${unknownArg} or use an argument declared by ${commandId}.`,
    });
  }
  return {
    argv: input.argv,
    parsedArgv: input.argv,
    flags: { ...input.flags },
    args: { ...input.args },
  };
};

export const makeEventCommandExecutor = (
  runtimeContext: Context.Context<unknown>,
  fixedEntries?: ReadonlyArray<BuiltInCommandEntry>,
): Context.Tag.Service<typeof EventCommandExecutor> => ({
  run(resolved: EventCommandExecutorInput) {
    return Effect.gen(function* () {
      const entries = fixedEntries ?? eventCommandEntries;
      const entry = entries.find((candidate) => candidate.spec.id === resolved.command);
      if (entry === undefined) {
        return yield* Effect.fail(
          new ToolingCompileError({
            message: `Unknown canonical command ${resolved.command}.`,
            tool: resolved.command,
            remediation: "Use a canonical command id from `lando --help`.",
          }),
        );
      }
      if (entry.status.kind === "deferred") {
        return yield* Effect.fail(notImplementedErrorForSpec(entry.spec));
      }
      const input = compileInput({
        entry,
        flags: resolved.flags,
        args: resolved.args,
        argv: resolved.argv,
        flagDefinitions: flagDefinitionsForCommand(entry),
        argDefinitions: argDefinitionsForCommand(entry),
      });
      if (input instanceof ToolingCompileError) return yield* Effect.fail(input);

      const operation = entry.spec.run(input).pipe(Effect.provideService(RuntimeCwd, resolved.cwd));
      const target = entry.spec.namespace === "app" ? withResolvedCwd(resolved.cwd, operation) : operation;
      const command =
        resolved.silent === true ? target.pipe(Effect.provideService(Renderer, silentRenderer)) : target;
      const invocation = yield* makeNestedCommandInvocation(entry.spec.id, {
        argv: input.argv,
        args: input.args,
        flags: input.flags,
        cwd: resolved.cwd,
      });
      const exit = yield* runCommandLifecycle(command, {
        invocation,
        ...(entry.spec.successExitCode === undefined
          ? {}
          : { successExitCode: (value) => entry.spec.successExitCode?.(value, input) }),
      });
      if (exit._tag === "Success") {
        if (resolved.silent !== true && entry.spec.render !== undefined) {
          const renderer = yield* Renderer;
          const rendered = entry.spec.render(exit.value, input, {
            mode: isRendererMode(renderer.id) ? renderer.id : DEFAULT_RENDERER_MODE,
            format: DEFAULT_RESULT_FORMAT,
            columns: undefined,
            isTTY: renderer.capabilities.interactive,
          });
          if (rendered !== undefined && rendered.length > 0) {
            yield* renderer.output.stdout(`${rendered}\n`);
          }
        }
        return {
          exitCode: entry.spec.successExitCode?.(exit.value, input) ?? 0,
          stdout: "",
          stderr: "",
        };
      }
      if (Cause.isInterruptedOnly(exit.cause)) return yield* Effect.interrupt;
      return yield* Effect.fail(Cause.squash(exit.cause));
    }).pipe(Effect.provide(Context.add(runtimeContext, EventCommandExecutor, this)));
  },
});

export const EventCommandExecutorLive = Layer.effect(
  EventCommandExecutor,
  Effect.map(Effect.context<unknown>(), makeEventCommandExecutor),
);
