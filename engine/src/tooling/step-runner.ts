import {
  bindToolingShellSite,
  compiledValueError,
  evaluateInvocationSite,
  instantiateInvocation,
  replaceSiteValue,
} from "@lando/landofile/compiled-sites";
import { mapFailures } from "@lando/sdk/command-result";
import { ConfigExpressionError, ToolingCompileError, ToolingStepConditionError } from "@lando/sdk/errors";
import type { ExpressionContext } from "@lando/sdk/expressions";
import type { SecretRef } from "@lando/sdk/schema";
import { Environment, EventForSelector, PortablePath } from "@lando/sdk/schema";
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

export { type DynamicToolingVarResolver, resolveToolingTaskShape } from "./task-shape.ts";

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
  let value = yield* instantiateInvocation({
    value: leaf,
    sites: sites.filter((site) => leaf.kind !== "cmd" || site.path[0] !== "command"),
    context,
  });
  const locate = (cause: unknown): ConfigExpressionError =>
    compiledValueError(cause, { filePath: "<tooling-step>", pendingSites: sites });
  const bindings: Record<string, SecretRef> = {};
  if (leaf.kind === "cmd") {
    for (const site of sites.filter((site) => site.path[0] === "command")) {
      const bound = yield* Effect.try({
        try: () => bindToolingShellSite(site, context, new Set(Object.keys(context.vars ?? {})), leaf.env),
        catch: (cause) =>
          cause instanceof ToolingCompileError || cause instanceof ConfigExpressionError
            ? cause
            : locate(cause),
      });
      Object.assign(bindings, bound.env);
      value = replaceSiteValue(value, site.path, bound.text);
    }
  }
  switch (leaf.kind) {
    case "cmd": {
      const resolved = yield* Schema.decodeUnknownEffect(ResolvedCmd)(value).pipe(mapFailures(locate));
      return {
        leaf:
          Object.keys(bindings).length === 0
            ? resolved
            : { ...resolved, env: { ...resolved.env, ...bindings } },
        context,
      };
    }
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
