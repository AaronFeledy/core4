import { type Context, Effect, Layer } from "effect";

import { ToolingCompileError } from "@lando/sdk/errors";

import { EventCommandExecutor } from "@lando/engine/services/event-command-executor";
import type { EventCommandExecutorInput } from "@lando/engine/services/event-command-executor";
import { withResolvedCwd } from "@lando/landofile/app-resolution";
import type { BuiltInCommandEntry } from "./built-in-command-registry";
import type { CompiledCommandInput } from "./compiled-runtime";

let eventCommandEntries: ReadonlyArray<BuiltInCommandEntry> = [];

export const injectEventCommandRegistry = (entries: ReadonlyArray<BuiltInCommandEntry>): void => {
  eventCommandEntries = entries;
};

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
): Context.Tag.Service<typeof EventCommandExecutor> => ({
  run: ({ step, cwd }: EventCommandExecutorInput) => {
    return Effect.suspend(() => {
      const entry = eventCommandEntries.find((candidate) => candidate.spec.id === step.command);
      if (entry === undefined) {
        return Effect.fail(
          new ToolingCompileError({
            message: `Unknown canonical command ${step.command}.`,
            tool: step.command,
            remediation: "Use a canonical command id from `lando --help`.",
          }),
        );
      }
      const input = compileInput({
        entry,
        flags: step.flags ?? {},
        args: step.args ?? [],
        flagDefinitions: flagDefinitionsForCommand(entry),
        argDefinitions: argDefinitionsForCommand(entry),
      });
      if (input instanceof ToolingCompileError) return Effect.fail(input);
      return withResolvedCwd(cwd, entry.spec.run(input)).pipe(
        Effect.provide(runtimeContext),
        Effect.as({ exitCode: 0, stdout: "", stderr: "" }),
      );
    });
  },
});

export const EventCommandExecutorLive = Layer.effect(
  EventCommandExecutor,
  Effect.map(Effect.context<unknown>(), makeEventCommandExecutor),
);
