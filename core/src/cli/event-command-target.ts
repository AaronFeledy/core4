import { Context, Effect, Option, Schema } from "effect";

import { PluginDescriptorMismatchError, PluginLoadError, ToolingCommandLookupError } from "@lando/sdk/errors";
import type {
  ExecutableCommandInput,
  ExecutableCommandLoader,
  ExecutableCommandNamespace,
  ExecutableCommandSpec,
} from "@lando/sdk/plugins";
import {
  type AppPlan,
  BootstrapLevel,
  type ToolingArgShape,
  type ToolingFlagShape,
  type ToolingTaskShape,
} from "@lando/sdk/schema";

import { runEventToolingCommand } from "@lando/engine/operations/event-tooling-command";
import { effectiveToolingForPlan } from "@lando/engine/planner/effective-tooling";
import { PluginContributionGraph } from "@lando/engine/plugins/contribution-graph";
import type { BuiltInCommandEntry } from "./built-in-command-registry";
import type { LandoCommandSpec } from "./spec/command-spec";

const loaderCache = new WeakMap<ExecutableCommandLoader, Promise<ExecutableCommandSpec>>();

const canonicalCommandIdPattern = /^[a-z][a-z0-9-]*(:[a-z][a-z0-9-]*)+$/u;
const coreNamespaces = new Set<ExecutableCommandNamespace>(["app", "apps", "meta"]);

const isExactToolingTarget = (command: string): boolean => {
  if (!command.startsWith("app:")) return false;
  const colon = command.indexOf(":", 4);
  return colon === -1;
};

const lookupTargetKind = (command: string): ToolingCommandLookupError["targetKind"] => {
  if (isExactToolingTarget(command)) return "tooling";
  const head = command.split(":", 1)[0] ?? command;
  if (coreNamespaces.has(head) || !command.includes(":")) return "built-in";
  return "plugin";
};

const loadPluginSpec = (
  id: string,
  pluginName: string,
  load: ExecutableCommandLoader,
): Effect.Effect<ExecutableCommandSpec, PluginDescriptorMismatchError | PluginLoadError> =>
  Effect.tryPromise({
    try: async () => {
      const cached = loaderCache.get(load);
      if (cached !== undefined) return cached;

      const spec = await load();
      const issues: string[] = [];
      const namespace = id.split(":", 1)[0] ?? id;
      if (spec.id !== id) issues.push(`id ${String(spec.id)} does not match ${id}`);
      if (spec.namespace !== namespace)
        issues.push(`namespace ${String(spec.namespace)} does not match ${namespace}`);
      if (!Schema.is(BootstrapLevel)(spec.bootstrap))
        issues.push(`bootstrap ${String(spec.bootstrap)} is not valid`);
      if (!Schema.isSchema(spec.resultSchema)) issues.push("resultSchema is not a schema instance");
      if (issues.length > 0) {
        throw new PluginDescriptorMismatchError({
          pluginName,
          kind: "commands",
          declared: [`id=${id}`, `namespace=${namespace}`, "bootstrap=valid", "resultSchema=schema"],
          provided: [
            `id=${String(spec.id)}`,
            `namespace=${String(spec.namespace)}`,
            `bootstrap=${String(spec.bootstrap)}`,
            `resultSchema=${Schema.isSchema(spec.resultSchema) ? "schema" : "non-schema"}`,
          ],
          message: `Plugin ${pluginName} command loader ${id} returned an invalid executable command spec: ${issues.join("; ")}.`,
          remediation:
            "Return an executable command spec whose id, namespace, bootstrap, and resultSchema match the manifest declaration.",
        });
      }
      const validated = Promise.resolve(spec);
      loaderCache.set(load, validated);
      return validated;
    },
    catch: (cause) =>
      cause instanceof PluginDescriptorMismatchError
        ? cause
        : new PluginLoadError({
            pluginName,
            message: `Plugin ${pluginName} command loader ${id} failed.`,
            cause,
          }),
  });

const toolingFlag = (definition: ToolingFlagShape) =>
  ({
    type: definition.type ?? "option",
    ...(definition.default === undefined ? {} : { default: definition.default }),
  }) satisfies NonNullable<ExecutableCommandSpec["flags"]>[string];

const toolingArg = (definition: ToolingArgShape) => ({
  type: "option" as const,
  ...(definition.required === undefined ? {} : { required: definition.required }),
  ...(definition.default === undefined ? {} : { default: definition.default }),
});

const toolingArgv = (task: ToolingTaskShape, input: ExecutableCommandInput): ReadonlyArray<string> => {
  const flags = Object.entries(input.flags).flatMap(([name, value]) =>
    typeof value === "boolean" ? (value ? [`--${name}`] : []) : [`--${name}=${String(value)}`],
  );
  const args = Object.keys(task.args ?? {}).flatMap((name) => {
    const value = input.args[name];
    return value === undefined ? [] : [String(value)];
  });
  return [...flags, ...args, ...input.argv];
};

const toolingSpec = (
  id: string,
  name: string,
  task: ToolingTaskShape,
  plan: AppPlan,
): ExecutableCommandSpec => ({
  id,
  summary: task.summary ?? task.description ?? `Run ${name} tooling.`,
  namespace: "app",
  bootstrap: "tooling",
  flags: Object.fromEntries(
    Object.entries(task.flags ?? {}).map(([key, value]) => [key, toolingFlag(value)]),
  ),
  args: Object.fromEntries(Object.entries(task.args ?? {}).map(([key, value]) => [key, toolingArg(value)])),
  strict: task.arguments === false,
  resultSchema: Schema.Unknown,
  run: (input) => runEventToolingCommand(plan, name, task, toolingArgv(task, input)),
  successExitCode: (result) =>
    typeof result === "object" &&
    result !== null &&
    "exitCode" in result &&
    typeof result.exitCode === "number"
      ? result.exitCode
      : undefined,
});

const distance = (left: string, right: string): number => {
  const row = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    let diagonal = row[0] ?? 0;
    row[0] = leftIndex;
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      const above = row[rightIndex] ?? 0;
      const cost = left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1;
      row[rightIndex] = Math.min((row[rightIndex - 1] ?? 0) + 1, above + 1, diagonal + cost);
      diagonal = above;
    }
  }
  return row[right.length] ?? left.length;
};

type BuiltInEventCommandTarget = {
  readonly kind: "built-in";
  readonly spec: LandoCommandSpec;
  readonly builtIn: BuiltInCommandEntry;
};

type PluginEventCommandTarget = {
  readonly kind: "plugin";
  readonly spec: ExecutableCommandSpec;
};

type ToolingEventCommandTarget = {
  readonly kind: "tooling";
  readonly spec: ExecutableCommandSpec;
  readonly toolingName: string;
};

export type EventCommandTarget =
  | BuiltInEventCommandTarget
  | PluginEventCommandTarget
  | ToolingEventCommandTarget;

const lookupFailure = (input: {
  readonly command: string;
  readonly builtIns: ReadonlyArray<BuiltInCommandEntry>;
  readonly graph: Option.Option<{ readonly commands: ReadonlyArray<{ readonly id: string }> }>;
  readonly tooling: Readonly<Record<string, ToolingTaskShape>> | undefined;
}): ToolingCommandLookupError => {
  const close = [
    ...input.builtIns.map((entry) => entry.spec.id),
    ...(Option.isSome(input.graph) ? input.graph.value.commands.map((candidate) => candidate.id) : []),
    ...Object.keys(input.tooling ?? {}).map((name) => `app:${name}`),
  ]
    .filter((id) => canonicalCommandIdPattern.test(id))
    .filter((id) => id !== input.command)
    .filter((id) => distance(input.command, id) <= 3)
    .slice(0, 3);
  return new ToolingCommandLookupError({
    message: `Unknown canonical command ${input.command}.`,
    target: input.command,
    targetKind: lookupTargetKind(input.command),
    remediation:
      close.length === 0
        ? "Use a registered built-in, plugin, or tooling canonical id."
        : `Did you mean ${close.join(", ")}?`,
    ...(close[0] === undefined ? {} : { commandId: close[0] }),
  });
};

export const resolveEventCommandTarget = (
  command: string,
  runtimeContext: Context.Context<never>,
  builtIns: ReadonlyArray<BuiltInCommandEntry>,
  plan?: AppPlan,
): Effect.Effect<
  EventCommandTarget,
  PluginDescriptorMismatchError | PluginLoadError | ToolingCommandLookupError
> => {
  const graph = Context.getOption(runtimeContext, PluginContributionGraph);
  const tooling = plan === undefined ? undefined : effectiveToolingForPlan(plan);
  if (!canonicalCommandIdPattern.test(command)) {
    return Effect.fail(lookupFailure({ command, builtIns, graph, tooling }));
  }
  const builtIn = builtIns.find((candidate) => candidate.spec.id === command);
  if (builtIn !== undefined) return Effect.succeed({ kind: "built-in", spec: builtIn.spec, builtIn });
  const plugin = Option.isSome(graph)
    ? graph.value.commands.find((candidate) => candidate.id === command)
    : undefined;
  if (plugin !== undefined) {
    return loadPluginSpec(plugin.id, plugin.pluginName, plugin.load).pipe(
      Effect.map((spec) => ({ kind: "plugin", spec })),
    );
  }
  const toolingName = isExactToolingTarget(command) ? command.slice(4) : undefined;
  const task = toolingName === undefined ? undefined : tooling?.[toolingName];
  if (task !== undefined && plan !== undefined && toolingName !== undefined) {
    return Effect.succeed({
      kind: "tooling",
      spec: toolingSpec(`app:${toolingName}`, toolingName, task, plan),
      toolingName,
    });
  }
  return Effect.fail(lookupFailure({ command, builtIns, graph, tooling }));
};
