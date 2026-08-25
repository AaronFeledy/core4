import { Cause, Context, Effect, Exit, Layer } from "effect";

import type { RendererIO } from "@lando/renderer/io";
import {
  type CommandInputValidationError,
  type ConfigError,
  type LandoRuntimeBootstrapError,
  ToolingCommandLookupError,
} from "@lando/sdk/errors";
import type { ExecutableCommandSpec } from "@lando/sdk/plugins";

import { PluginContributionGraph } from "@lando/engine/plugins/contribution-graph";
import { cliRuntimeOptions } from "@lando/engine/runtime/cli-options";
import { makeLandoRuntime } from "../runtime/layer";
import { builtInCommandEntries } from "./built-in-command-registry";
import { helpArgToken, helpFlagToken } from "./cli-help";
import { type OclifFlagDefinition, flagNameByToken, setParsedFlag } from "./compiled-argv";
import {
  emitJsonListModeIfRequested,
  emitResultLine,
  runCompiledCommand,
  runWithProcessAbortSignal,
} from "./compiled-runtime";
import { validateEventCommandInput } from "./event-command-input";
import { resolveEventCommandTarget } from "./event-command-target";
import {
  type MalformedCliFlagValueError,
  type UnknownCliFlagError,
  normalizeCliFlagTokens,
  validateCommandCliFlags,
} from "./flag-value-validation";
import { universalFormatFlagDefs } from "./format-flags";

const PLUGIN_OWNED_COMMAND_ID = /^[a-z][a-z0-9-]*(:[a-z][a-z0-9-]*)+$/u;

export const isPluginOwnedCommandId = (token: string): boolean => PLUGIN_OWNED_COMMAND_ID.test(token);

export interface RunPluginOwnedCommandOptions {
  readonly io?: RendererIO;
}

type PluginOwnedRuntime = Layer.Layer<unknown, ConfigError | LandoRuntimeBootstrapError>;

const pluginFlagDefinitions = (
  spec: Pick<ExecutableCommandSpec, "flags">,
): Readonly<Record<string, OclifFlagDefinition>> => {
  const flags: Record<string, OclifFlagDefinition> = { ...universalFormatFlagDefs };
  for (const [name, definition] of Object.entries(spec.flags ?? {})) {
    flags[name] = {
      name,
      type: definition.type === "boolean" ? "boolean" : "option",
      ...(definition.description === undefined ? {} : { description: definition.description }),
      ...(definition.multiple === undefined ? {} : { multiple: definition.multiple }),
      ...(definition.options === undefined ? {} : { options: definition.options }),
    };
  }
  return flags;
};

export const pluginOwnedCliFlagError = (
  spec: Pick<ExecutableCommandSpec, "id" | "flags" | "strict">,
  argv: ReadonlyArray<string>,
): MalformedCliFlagValueError | UnknownCliFlagError | undefined =>
  validateCommandCliFlags({
    commandId: spec.id,
    argv,
    definitions: pluginFlagDefinitions(spec),
    allowUnknownFlags: spec.strict === false,
  });

export const pluginOwnedCommandInputFromArgv = (
  spec: Pick<ExecutableCommandSpec, "flags" | "args" | "strict">,
  argv: ReadonlyArray<string>,
): {
  readonly flags: Readonly<Record<string, unknown>>;
  readonly args: Readonly<Record<string, unknown>>;
  readonly raw: ReadonlyArray<string>;
} => {
  const flagDefinitions = pluginFlagDefinitions(spec);
  const normalizedArgv = normalizeCliFlagTokens(argv, flagDefinitions);
  const flagTokens = flagNameByToken(flagDefinitions);
  const flags: Record<string, unknown> = {};
  const positionals: string[] = [];

  for (let index = 0; index < normalizedArgv.length; index += 1) {
    const arg = normalizedArgv[index];
    if (arg === undefined) continue;
    if (arg === "--") {
      positionals.push(...normalizedArgv.slice(index + 1));
      break;
    }
    const equalsIndex = arg.indexOf("=");
    const token = equalsIndex === -1 ? arg : arg.slice(0, equalsIndex);
    const flagName = flagTokens.get(token);
    if (flagName !== undefined) {
      const definition = flagDefinitions[flagName] ?? {};
      if (definition.type === "boolean") {
        setParsedFlag(flags, flagName, true, definition);
        continue;
      }
      const value = equalsIndex === -1 ? normalizedArgv[index + 1] : arg.slice(equalsIndex + 1);
      if (value === undefined) continue;
      const specFlag = spec.flags?.[flagName];
      if (specFlag?.type === "number" || specFlag?.valueType === "integer") {
        const parsed = specFlag.valueType === "integer" ? Number.parseInt(value, 10) : Number(value);
        if (Number.isFinite(parsed)) flags[flagName] = parsed;
      } else {
        setParsedFlag(flags, flagName, value, definition);
      }
      if (equalsIndex === -1) index += 1;
      continue;
    }
    if (spec.strict === false || !arg.startsWith("-")) positionals.push(arg);
  }

  const argNames = Object.keys(spec.args ?? {});
  const args: Record<string, unknown> = {};
  const raw: string[] = [];
  for (const [index, value] of positionals.entries()) {
    const name = argNames[index];
    if (name === undefined) raw.push(value);
    else args[name] = value;
  }
  return { flags, args, raw };
};

export const renderPluginOwnedCommandHelp = (spec: ExecutableCommandSpec): string => {
  const argEntries = Object.entries(spec.args ?? {});
  const repeatable = spec.strict === false && argEntries.length === 1;
  const usageArgs = argEntries.map(([name, definition]) =>
    helpArgToken(
      name,
      definition.required === undefined ? {} : { required: definition.required },
      repeatable,
    ),
  );
  const usage = usageArgs.length === 0 ? spec.id : `${spec.id} ${usageArgs.join(" ")}`;
  const flagEntries = Object.entries(pluginFlagDefinitions(spec)).sort(([left], [right]) =>
    left.localeCompare(right),
  );
  const lines = [spec.summary, "", "USAGE", `  $ lando ${usage}`];
  if (flagEntries.length > 0) {
    lines.push("", "FLAGS");
    for (const [name, definition] of flagEntries) {
      lines.push(`  ${helpFlagToken(name, definition)}`);
    }
  }
  return lines.join("\n");
};

const defaultPluginRuntime = (bootstrap: ExecutableCommandSpec["bootstrap"]): PluginOwnedRuntime =>
  makeLandoRuntime(cliRuntimeOptions({ bootstrap, plugins: { policy: "discovery" } })) as PluginOwnedRuntime;

const compiledPluginOptions = (spec: ExecutableCommandSpec, options: RunPluginOwnedCommandOptions) => ({
  resultSchema: spec.resultSchema,
  ...(options.io === undefined ? {} : { io: options.io }),
  ...(spec.successExitCode === undefined
    ? {}
    : { successExitCode: (result: unknown) => spec.successExitCode?.(result) }),
  ...(spec.redactionTokens === undefined
    ? {}
    : { redactionTokens: (result: unknown) => spec.redactionTokens?.(result) ?? [] }),
});

const pluginOwnedCommandEffect = <A, E, R>(
  spec: Pick<ExecutableCommandSpec<A, E, R>, "id" | "flags" | "args" | "strict" | "run">,
  argv: ReadonlyArray<string>,
): Effect.Effect<
  A,
  E | CommandInputValidationError | MalformedCliFlagValueError | UnknownCliFlagError,
  R
> => {
  const flagError = pluginOwnedCliFlagError(spec, argv);
  if (flagError !== undefined) return Effect.fail(flagError);
  const parsed = pluginOwnedCommandInputFromArgv(spec, argv);
  return validateEventCommandInput(spec, parsed).pipe(Effect.flatMap((input) => spec.run(input)));
};

const renderPluginOwnedPreCommandFailure = async (error: unknown, io?: RendererIO): Promise<void> => {
  await runCompiledCommand(Effect.fail(error), Layer.empty, () => undefined, {
    failureExitCode: () => 2,
    preCommand: true,
    ...(io === undefined ? {} : { io }),
  });
};

const runPluginOwnedCommand = (
  spec: ExecutableCommandSpec,
  argv: ReadonlyArray<string>,
  options: RunPluginOwnedCommandOptions = {},
): Promise<void> =>
  runWithProcessAbortSignal(async () => {
    const flagError = pluginOwnedCliFlagError(spec, argv);
    if (flagError !== undefined) {
      await renderPluginOwnedPreCommandFailure(flagError, options.io);
      return;
    }
    await runCompiledCommand(
      pluginOwnedCommandEffect(spec, argv),
      defaultPluginRuntime(spec.bootstrap),
      () => undefined,
      compiledPluginOptions(spec, options),
    );
  });

const resolvePluginOwnedFromGraph = (commandId: string) =>
  Effect.gen(function* () {
    const graph = yield* PluginContributionGraph;
    const context = Context.make(PluginContributionGraph, graph);
    const exit = yield* Effect.either(resolveEventCommandTarget(commandId, context, builtInCommandEntries));
    if (exit._tag === "Left") {
      if (exit.left instanceof ToolingCommandLookupError) return undefined;
      return yield* Effect.fail(exit.left);
    }
    return exit.right.kind === "plugin" ? exit.right.spec : undefined;
  });

const dispatchPluginOwnedCommand = async (
  commandId: string,
  argv: ReadonlyArray<string>,
): Promise<"dispatched" | "not-found"> => {
  const exit = await Effect.runPromiseExit(
    Effect.scoped(resolvePluginOwnedFromGraph(commandId).pipe(Effect.provide(defaultPluginRuntime("app")))),
  );
  if (Exit.isFailure(exit)) {
    await renderPluginOwnedPreCommandFailure(Cause.squash(exit.cause));
    return "dispatched";
  }
  const spec = exit.value;
  if (spec === undefined) return "not-found";
  if (argv.includes("--help") || argv.includes("-h")) {
    emitResultLine(renderPluginOwnedCommandHelp(spec));
    return "dispatched";
  }
  if (emitJsonListModeIfRequested(spec.resultSchema)) return "dispatched";
  await runPluginOwnedCommand(spec, argv);
  return "dispatched";
};

export const tryPluginOwnedCommand = async (token: string, argv: ReadonlyArray<string>): Promise<boolean> =>
  isPluginOwnedCommandId(token) && (await dispatchPluginOwnedCommand(token, argv)) === "dispatched";
