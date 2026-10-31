import { commandCompletionFromExitCode } from "@lando/sdk/command-result";
import { Context, Effect, Option, Schema } from "effect";

import {
  PluginDescriptorMismatchError,
  PluginLoadError,
  ToolingCommandLookupError,
  type ToolingCompileError,
} from "@lando/sdk/errors";
import type {
  ExecutableCommandLoader,
  ExecutableCommandNamespace,
  ExecutableCommandSpec,
} from "@lando/sdk/plugins";
import {
  type AppPlan,
  BootstrapLevel,
  type CommandContribution,
  type ToolingTaskShape,
} from "@lando/sdk/schema";

import { runEventToolingCommand } from "@lando/engine/operations/event-tooling-command";
import { effectiveToolingForPlan } from "@lando/engine/planner/effective-tooling";
import { PluginContributionGraph } from "@lando/engine/plugins/contribution-graph";
import { type NormalizedToolingTask, normalizeToolingTask } from "@lando/landofile/tooling-normalize";
import { destructiveCommandVerbs, isMcpDestructiveCommand } from "@lando/mcp/allowlist";
import type { BuiltInCommandEntry } from "./built-in-command-registry";
import { resolveEventScriptTarget } from "./event-script-target";
import type { LandoCommandSpec } from "./spec/command-spec";
export { destructiveCommandVerbs } from "@lando/mcp/allowlist";

const loaderCache = new WeakMap<ExecutableCommandLoader, Promise<ExecutableCommandSpec>>();
const commandDeclaration = Schema.Struct({
  type: Schema.Literals(["boolean", "option", "string", "number"]),
  description: Schema.optionalKey(Schema.String),
  required: Schema.optionalKey(Schema.Boolean),
  multiple: Schema.optionalKey(Schema.Boolean),
  valueType: Schema.optionalKey(Schema.Literals(["string", "integer"])),
  default: Schema.optionalKey(Schema.Union([Schema.String, Schema.Number, Schema.Boolean, Schema.Undefined])),
  options: Schema.optionalKey(Schema.Array(Schema.String)),
});
const commandMetadata = Schema.Struct({
  summary: Schema.optionalKey(Schema.NonEmptyString.check(Schema.isPattern(/\S/u))),
  flags: Schema.optionalKey(Schema.Record(Schema.String, commandDeclaration)),
  args: Schema.optionalKey(Schema.Record(Schema.String, commandDeclaration)),
});
const executableSpecRemediation =
  "Return a spec with a nonempty summary, a run function, valid flags/args, and id, namespace, bootstrap, and resultSchema matching the manifest declaration. Declare any `yes` flag as a plain boolean; the CLI owns --yes/-y.";

const canonicalCommandIdPattern = /^[a-z][a-z0-9-]*(:[a-z][a-z0-9-]*)+$/u;
export type ResolvedPluginCommandSpec = ExecutableCommandSpec & { readonly summary: string };
export const isDestructivePluginCommand = (spec: Pick<ExecutableCommandSpec, "id" | "flags">): boolean =>
  isMcpDestructiveCommand(spec);
const coreNamespaces = new Set<ExecutableCommandNamespace>(["app", "apps", "meta"]);

const isToolingTarget = (command: string): boolean => command.startsWith("app:") && command.length > 4;

const lookupTargetKind = (command: string): ToolingCommandLookupError["targetKind"] => {
  if (isToolingTarget(command)) return "tooling";
  const head = command.split(":", 1)[0] ?? command;
  if (coreNamespaces.has(head) || !command.includes(":")) return "built-in";
  return "plugin";
};

export const loadPluginSpec = (
  id: string,
  pluginName: string,
  load: ExecutableCommandLoader,
  descriptor?: CommandContribution,
): Effect.Effect<ResolvedPluginCommandSpec, PluginDescriptorMismatchError | PluginLoadError> =>
  Effect.tryPromise({
    try: async () => {
      const cached = loaderCache.get(load);
      const spec = await (cached ?? load());
      const issues: string[] = [];
      if (typeof spec !== "object" || spec === null) {
        throw new PluginLoadError({
          pluginName,
          message: `Plugin ${pluginName} command ${id} has invalid summary, run, flags, or args metadata.`,
          remediation: executableSpecRemediation,
        });
      }
      if (!Schema.is(commandMetadata)(spec) || typeof spec.run !== "function")
        issues.push("summary, run, flags, or args metadata is invalid");
      if (descriptor !== undefined && spec.summary !== undefined && spec.summary !== descriptor.summary)
        issues.push("module summary differs from the manifest summary");
      const summary = descriptor?.summary ?? spec.summary;
      if (summary === undefined) issues.push("manifest summary is missing");
      if (Object.values(spec.args ?? {}).some((arg) => arg.type !== "option" && arg.type !== "string"))
        issues.push("args must use option or string declarations");
      if (Object.values(spec.flags ?? {}).some((flag) => "parse" in flag && typeof flag.parse !== "function"))
        issues.push("flag parse must be a function when present");
      const namespace = id.split(":", 1)[0] ?? id;
      if (!canonicalCommandIdPattern.test(spec.id)) issues.push("id must be a canonical command id");
      if (spec.id !== id) issues.push(`id ${String(spec.id)} does not match ${id}`);
      if (spec.namespace !== namespace)
        issues.push(`namespace ${String(spec.namespace)} does not match ${namespace}`);
      if (!Schema.is(BootstrapLevel)(spec.bootstrap))
        issues.push(`bootstrap ${String(spec.bootstrap)} is not valid`);
      if (!Schema.isSchema(spec.resultSchema)) issues.push("resultSchema is not a schema instance");
      const yes = spec.flags?.yes;
      if (destructiveCommandVerbs.has(spec.id.slice(spec.id.lastIndexOf(":") + 1)) && yes === undefined)
        issues.push("destructive commands must declare a yes flag");
      const compatibleYes =
        yes === undefined ||
        (yes.type === "boolean" &&
          (yes.default === undefined || yes.default === false) &&
          Object.keys(yes).every((key) => key === "type" || key === "default" || key === "description"));
      if (!compatibleYes) issues.push("flag yes must be an optional boolean defaulting to false");
      if (issues.length > 0) {
        let yesDeclaration = "absent";
        if (yes !== undefined) {
          yesDeclaration = compatibleYes ? "optional-boolean-default-false" : "incompatible";
        }
        throw new PluginDescriptorMismatchError({
          pluginName,
          kind: "commands",
          declared: [
            `id=${id}`,
            `namespace=${namespace}`,
            "bootstrap=valid",
            "resultSchema=schema",
            "flags.yes=absent-or-optional-boolean-default-false",
          ],
          provided: [
            `id=${String(spec.id)}`,
            `namespace=${String(spec.namespace)}`,
            `bootstrap=${String(spec.bootstrap)}`,
            `resultSchema=${Schema.isSchema(spec.resultSchema) ? "schema" : "non-schema"}`,
            `flags.yes=${yesDeclaration}`,
          ],
          message: `Plugin ${pluginName} command loader ${id} returned an invalid executable command spec: ${issues.join("; ")}.`,
          remediation: executableSpecRemediation,
        });
      }
      if (cached === undefined) loaderCache.set(load, Promise.resolve(spec));
      return { ...spec, summary: summary ?? "" };
    },
    catch: (cause) =>
      cause instanceof PluginDescriptorMismatchError || cause instanceof PluginLoadError
        ? cause
        : new PluginLoadError({
            pluginName,
            message: `Plugin ${pluginName} command loader ${id} failed.`,
            cause,
            remediation: `Repair plugin ${pluginName} so command loader ${id} succeeds.`,
          }),
  }).pipe(
    Effect.timeoutOrElse({
      duration: "5 seconds",
      orElse: () =>
        Effect.fail(
          new PluginLoadError({
            pluginName,
            message: `Plugin ${pluginName} command loader ${id} timed out.`,
            remediation: `Repair plugin ${pluginName} so its asynchronous command loader completes.`,
          }),
        ),
    }),
  );

const toolingSpec = (
  declaration: NormalizedToolingTask,
  task: ToolingTaskShape,
  plan: AppPlan,
): ExecutableCommandSpec => ({
  id: `app:${declaration.name}`,
  summary: declaration.summary ?? `Run ${declaration.name} tooling.`,
  namespace: "app",
  bootstrap: "tooling",
  resultSchema: Schema.Unknown,
  run: (input) =>
    runEventToolingCommand({
      plan,
      name: declaration.name,
      task,
      input: { _tag: "NamedMaps", flags: input.flags, args: input.args, passthroughArgv: input.argv },
      expectedInputRevision: declaration.input.revision,
    }),
  completion: (result) =>
    commandCompletionFromExitCode(
      Schema.decodeUnknownSync(Schema.Struct({ exitCode: Schema.Number }))(result).exitCode,
    ),
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
  readonly toolingTask?: ToolingTaskShape;
  readonly toolingInput: NormalizedToolingTask["input"];
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
  | PluginDescriptorMismatchError
  | PluginLoadError
  | ToolingCommandLookupError
  | ToolingCompileError
  | Effect.Error<ReturnType<typeof resolveEventScriptTarget>>
> => {
  const graph = Context.getOption(runtimeContext, PluginContributionGraph);
  const tooling = plan === undefined ? undefined : effectiveToolingForPlan(plan);
  if (!canonicalCommandIdPattern.test(command)) {
    return Effect.fail(lookupFailure({ command, builtIns, graph, tooling }));
  }
  const builtIn = builtIns.find((candidate) => candidate.spec.id === command);
  if (builtIn !== undefined) {
    return Effect.succeed({ kind: "built-in", spec: builtIn.spec, builtIn });
  }
  const plugin = Option.isSome(graph)
    ? graph.value.commands.find((candidate) => candidate.id === command)
    : undefined;
  if (plugin !== undefined) {
    return loadPluginSpec(plugin.id, plugin.pluginName, plugin.load, plugin.descriptor).pipe(
      Effect.map((spec) => ({ kind: "plugin", spec })),
    );
  }
  const toolingName = isToolingTarget(command) ? command.slice(4) : undefined;
  const task = toolingName === undefined ? undefined : tooling?.[toolingName];
  if (task !== undefined && plan !== undefined && toolingName !== undefined) {
    return Effect.map(
      Effect.fromResult(normalizeToolingTask(toolingName, task, { path: plan.metadata.source })),
      (declaration): EventCommandTarget => ({
        kind: "tooling",
        spec: toolingSpec(declaration, task, plan),
        toolingName,
        toolingTask: task,
        toolingInput: declaration.input,
      }),
    );
  }
  if (plan !== undefined && toolingName !== undefined)
    return resolveEventScriptTarget(toolingName, plan).pipe(
      Effect.flatMap((target) =>
        target === undefined
          ? Effect.fail(lookupFailure({ command, builtIns, graph, tooling }))
          : Effect.succeed(target),
      ),
    );
  return Effect.fail(lookupFailure({ command, builtIns, graph, tooling }));
};
