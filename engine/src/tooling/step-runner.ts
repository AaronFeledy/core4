import {
  type InvocationProgram,
  bindToolingShellSite,
  compiledValueError,
  dynamicToolingNames,
  dynamicToolingReferenceIssues,
  evaluateInvocationSite,
  instantiateInvocation,
  replaceSiteValue,
} from "@lando/landofile/compiled-sites";
import { mapFailures } from "@lando/sdk/command-result";
import {
  type ConfigExpressionError,
  ToolingCompileError,
  ToolingStepConditionError,
} from "@lando/sdk/errors";
import type { ExpressionContext } from "@lando/sdk/expressions";
import { Environment, EventForSelector, PortablePath, ToolingTaskShape } from "@lando/sdk/schema";
import { Effect, Schema } from "effect";
import { compileSelector } from "./step-compiler.ts";
import { runToolingStepProgramWith } from "./step-executor.ts";
import type { ToolingStepForNode, ToolingStepLeaf, ToolingStepProgram } from "./step-program.ts";
import type { ToolingStepRunners } from "./step-runner-types.ts";

const Base = {
  authoredIndex: Schema.Number,
  source: Schema.optionalKey(Schema.Literals(["host", "project"])),
  silent: Schema.Boolean,
  ignoreError: Schema.Boolean,
};
const ResolvedCmd = Schema.Struct({
  ...Base,
  kind: Schema.Literal("cmd"),
  command: Schema.String,
  service: Schema.optionalKey(Schema.String),
  dir: Schema.optionalKey(PortablePath),
  user: Schema.optionalKey(Schema.String),
  env: Schema.optionalKey(Environment),
});
const ResolvedTask = Schema.Struct({
  ...Base,
  kind: Schema.Literal("task"),
  task: Schema.String,
  vars: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
});
const ResolvedCommand = Schema.Struct({
  ...Base,
  kind: Schema.Literal("command"),
  command: Schema.String,
  flags: Schema.Record(Schema.String, Schema.Unknown),
  args: Schema.Record(Schema.String, Schema.Unknown),
  raw: Schema.Array(Schema.String),
});

export type DynamicToolingVarResolver<E, R> = (input: {
  readonly name: string;
  readonly command: string;
  readonly task: ToolingTaskShape;
}) => Effect.Effect<string, E, R>;

export const resolveToolingTaskShape = Effect.fnUntraced(function* <E = never, R = never>(
  task: ToolingTaskShape,
  context: ExpressionContext,
  program: InvocationProgram,
  dynamic?: {
    /** Effective task name, used to locate failures at `tooling.<name>`. */
    readonly name: string;
    readonly evaluate: DynamicToolingVarResolver<E, R>;
  },
) {
  const issue = dynamicToolingReferenceIssues(task, program)[0];
  if (issue !== undefined)
    return yield* Effect.fail(
      new ToolingCompileError({
        tool: dynamic?.name ?? "<tooling-task>",
        message: `${["tooling", ...(dynamic === undefined ? [] : [dynamic.name]), ...issue.path].join(".")}: ${issue.message}`,
        remediation: issue.suggestion,
      }),
    );
  const names = dynamicToolingNames(task);
  const variableValue = yield* instantiateInvocation({
    value: task,
    sites: program.filter(
      (site) => site.path[0] === "vars" && !Object.hasOwn(context.vars ?? {}, String(site.path[1])),
    ),
    context: { ...context, vars: { ...task.vars, ...context.vars } },
  });
  const variables = yield* Schema.decodeUnknownEffect(ToolingTaskShape)(variableValue).pipe(
    mapFailures((cause) => compiledValueError(cause, { filePath: "<tooling-task>", pendingSites: program })),
  );
  const targetValue = yield* instantiateInvocation({
    value: variables,
    sites: program.filter(
      (site) => site.path.length === 1 && ["service", "user", "dir"].includes(String(site.path[0])),
    ),
    context: { ...context, vars: { ...variables.vars, ...context.vars } },
  });
  const target = yield* Schema.decodeUnknownEffect(ToolingTaskShape)(targetValue).pipe(
    mapFailures((cause) => compiledValueError(cause, { filePath: "<tooling-task>", pendingSites: program })),
  );
  const vars: Record<string, unknown> = { ...target.vars, ...context.vars };
  for (const [name, variable] of Object.entries(target.vars ?? {})) {
    if (typeof variable !== "object" || Object.hasOwn(context.vars ?? {}, name)) continue;
    if (dynamic === undefined)
      return yield* Effect.fail(
        new ToolingCompileError({
          tool: "<tooling-task>",
          message: `No evaluator is available for vars.${name}.sh.`,
          remediation: "Provide a dynamic var evaluator before resolving this task.",
        }),
      );
    vars[name] = yield* dynamic.evaluate({ name, command: variable.sh, task: target });
  }
  const resolvedVars: Record<string, unknown> = { ...target.vars };
  for (const name of names) resolvedVars[name] = vars[name];
  const resolvedContext = { ...context, vars };
  let value: unknown = { ...target, ...(target.vars === undefined ? {} : { vars: resolvedVars }) };
  for (const site of program.filter(
    (site) =>
      site.path[0] !== "vars" &&
      !(site.path.length === 1 && ["service", "user", "dir"].includes(String(site.path[0]))),
  )) {
    const shell =
      (site.path[0] === "cmd" && site.path.length === 1) ||
      (site.path[0] === "cmds" &&
        (site.path.length === 2 || (site.path.length === 3 && site.path[2] === "cmd")));
    const resolved = yield* Effect.try({
      try: () =>
        shell && names.size > 0
          ? bindToolingShellSite(site, resolvedContext, names)
          : evaluateInvocationSite(site, resolvedContext),
      catch: (cause) =>
        cause instanceof ToolingCompileError
          ? cause
          : compiledValueError(cause, { filePath: "<tooling-task>", pendingSites: [site] }),
    });
    const environment = site.path[0] === "env" || (site.path[0] === "cmds" && site.path[2] === "env");
    value = replaceSiteValue(
      value,
      site.path,
      environment && (typeof resolved === "number" || typeof resolved === "boolean")
        ? String(resolved)
        : resolved,
    );
  }
  return yield* Schema.decodeUnknownEffect(ToolingTaskShape)(value).pipe(
    mapFailures((cause) => compiledValueError(cause, { filePath: "<tooling-task>", pendingSites: program })),
  );
});

export const conditionAllows = (condition: ToolingStepLeaf["condition"], context: ExpressionContext) => {
  if (condition === undefined || typeof condition === "boolean") return Effect.succeed(condition ?? true);
  const expression = typeof condition === "string" ? condition : condition.expression;
  return Effect.try({
    try: () => {
      if (typeof condition === "string")
        throw new ToolingStepConditionError({
          message: "Unrecorded string predicates are not executable.",
          condition,
          remediation: "Use a recorded authored expression or a boolean literal.",
        });
      const value = evaluateInvocationSite(condition, context);
      if (typeof value !== "boolean")
        throw new ToolingStepConditionError({
          message: "Tooling step condition must evaluate to a boolean.",
          condition: expression,
          remediation: "Use a whole expression that evaluates to a boolean.",
        });
      return value;
    },
    catch: (cause) =>
      cause instanceof ToolingStepConditionError
        ? cause
        : new ToolingStepConditionError({
            message: "Tooling step condition evaluation failed.",
            condition: expression,
            cause,
            remediation: "Use a whole expression that evaluates to a boolean.",
          }),
  });
};

export const resolveLeaf = Effect.fnUntraced(function* (leaf: ToolingStepLeaf, context: ExpressionContext) {
  const sites = leaf.invocationSites ?? [];
  const value = yield* instantiateInvocation({ value: leaf, sites, context });
  const locate = (cause: unknown): ConfigExpressionError =>
    compiledValueError(cause, { filePath: "<tooling-step>", pendingSites: sites });
  switch (leaf.kind) {
    case "cmd":
      return {
        leaf: yield* Schema.decodeUnknownEffect(ResolvedCmd)(value).pipe(mapFailures(locate)),
        context,
      };
    case "command":
      return {
        leaf: yield* Schema.decodeUnknownEffect(ResolvedCommand)(value).pipe(mapFailures(locate)),
        context,
      };
    case "task": {
      const resolved = yield* Schema.decodeUnknownEffect(ResolvedTask)(value).pipe(mapFailures(locate));
      const vars = { ...context.vars, ...resolved.vars };
      return { leaf: { ...resolved, vars }, context: { ...context, vars } };
    }
    default:
      return leaf satisfies never;
  }
});

export const runToolingStepProgram = <E, A>(
  program: ToolingStepProgram,
  context: ExpressionContext,
  runners: ToolingStepRunners<E, A>,
) => runToolingStepProgramWith(program, context, runners, { conditionAllows, resolveLeaf, resolveSelector });

const resolveSelector = Effect.fnUntraced(function* (node: ToolingStepForNode, context: ExpressionContext) {
  if (node.selectorInvocation === undefined) return node.selector;
  const { value, sites } = node.selectorInvocation;
  const instantiated = yield* instantiateInvocation({ value, sites, context });
  const locate = (cause: unknown) =>
    compiledValueError(cause, { filePath: "<tooling-selector>", pendingSites: sites });
  const decoded = yield* Schema.decodeUnknownEffect(EventForSelector)(instantiated).pipe(mapFailures(locate));
  return yield* compileSelector(decoded).pipe(mapFailures(locate));
});

export type {
  ResolvedToolingCmdStepLeaf,
  ResolvedToolingCommandStepLeaf,
  ResolvedToolingStepLeaf,
  ResolvedToolingTaskStepLeaf,
  ToolingStepExpressionError,
  ToolingStepRunners,
} from "./step-runner-types.ts";
