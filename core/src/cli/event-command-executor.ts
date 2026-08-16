import { Cause, type Context, Effect, Layer } from "effect";

import { ToolingCompileError } from "@lando/sdk/errors";
import { RENDERER_CAPABILITIES_NONE } from "@lando/sdk/renderer";
import { Renderer } from "@lando/sdk/services";

import { RuntimeCwd } from "@lando/engine/runtime/cwd";
import { EventCommandExecutor } from "@lando/engine/services/event-command-executor";
import type { EventCommandExecutorInput } from "@lando/engine/services/event-command-executor";
import type { BuiltInCommandEntry } from "./built-in-command-registry";
import { makeNestedCommandInvocation, runCommandLifecycle } from "./command-lifecycle";
import type { CompiledCommandInput } from "./compiled-runtime";

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
  readonly args: ReadonlyArray<string>;
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
  const argNames = Object.keys(input.argDefinitions);
  if (input.args.length > argNames.length) {
    return new ToolingCompileError({
      message: `Too many arguments for canonical command ${commandId}.`,
      tool: commandId,
      remediation: `Pass at most ${argNames.length} positional arguments.`,
    });
  }
  return {
    argv: [],
    flags: { ...input.flags },
    args: Object.fromEntries(
      argNames.flatMap((name, index) => (input.args[index] === undefined ? [] : [[name, input.args[index]]])),
    ),
  };
};

export const makeEventCommandExecutor = (
  runtimeContext: Context.Context<unknown>,
  fixedEntries?: ReadonlyArray<BuiltInCommandEntry>,
): Context.Tag.Service<typeof EventCommandExecutor> => ({
  run: (resolved: EventCommandExecutorInput) =>
    Effect.gen(function* () {
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
      const input = compileInput({
        entry,
        flags: resolved.flags,
        args: resolved.args,
        flagDefinitions: flagDefinitionsForCommand(entry),
        argDefinitions: argDefinitionsForCommand(entry),
      });
      if (input instanceof ToolingCompileError) return yield* Effect.fail(input);

      const target = entry.spec.run(input).pipe(Effect.provideService(RuntimeCwd, resolved.cwd));
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
        return {
          exitCode: entry.spec.successExitCode?.(exit.value, input) ?? 0,
          stdout: "",
          stderr: "",
        };
      }
      if (Cause.isInterruptedOnly(exit.cause)) return yield* Effect.interrupt;
      return yield* Effect.fail(Cause.squash(exit.cause));
    }).pipe(Effect.provide(runtimeContext)),
});

export const EventCommandExecutorLive = Layer.effect(
  EventCommandExecutor,
  Effect.map(Effect.context<unknown>(), makeEventCommandExecutor),
);
