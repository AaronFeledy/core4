import { Effect } from "effect";

import { ToolingStepConditionError } from "@lando/sdk/errors";
import { type ExpressionContext, evaluateTemplate, parseExpression } from "@lando/sdk/expressions";
import {
  type EventCommandInputValue,
  PortablePath,
  type ToolingTaskShape,
  type ToolingVarLiteral,
} from "@lando/sdk/schema";

import { runToolingStepProgramWith } from "./step-executor.ts";
import type {
  ToolingCmdStepLeaf,
  ToolingCommandStepLeaf,
  ToolingStepLeaf,
  ToolingStepProgram,
  ToolingTaskStepLeaf,
} from "./step-program.ts";
import type { ToolingStepExpressionError, ToolingStepRunners } from "./step-runner-types.ts";

const EXPRESSION_FILE = "<tooling-step>";

const resolve = (
  value: string,
  context: ExpressionContext,
): Effect.Effect<unknown, ToolingStepExpressionError> =>
  parseExpression(value, { filePath: EXPRESSION_FILE }).pipe(
    Effect.flatMap((template) => evaluateTemplate(template, context, { filePath: EXPRESSION_FILE })),
  );

const resolveString = (
  value: string,
  context: ExpressionContext,
): Effect.Effect<string, ToolingStepExpressionError> =>
  resolve(value, context).pipe(Effect.map((resolved) => String(resolved)));

const resolveLiteral = (
  value: ToolingVarLiteral,
  context: ExpressionContext,
): Effect.Effect<unknown, ToolingStepExpressionError> =>
  typeof value === "string" ? resolve(value, context) : Effect.succeed(value);

const resolveRecord = (
  values: Readonly<Record<string, ToolingVarLiteral>>,
  context: ExpressionContext,
): Effect.Effect<Readonly<Record<string, unknown>>, ToolingStepExpressionError> =>
  Effect.forEach(Object.entries(values), ([name, value]) =>
    resolveLiteral(value, context).pipe(Effect.map((resolved) => [name, resolved] as const)),
  ).pipe(Effect.map(Object.fromEntries));

/** `Array.isArray` alone leaves `readonly string[]` in the scalar branch. */
const isRepeatableInput = (value: EventCommandInputValue): value is ReadonlyArray<string> =>
  Array.isArray(value);

const resolveCommandValue = (
  value: EventCommandInputValue,
  context: ExpressionContext,
): Effect.Effect<unknown, ToolingStepExpressionError> =>
  isRepeatableInput(value)
    ? Effect.forEach(value, (entry) => resolve(entry, context))
    : resolveLiteral(value, context);

const resolveCommandRecord = (
  values: Readonly<Record<string, EventCommandInputValue>>,
  context: ExpressionContext,
): Effect.Effect<Readonly<Record<string, unknown>>, ToolingStepExpressionError> =>
  Effect.forEach(Object.entries(values), ([name, value]) =>
    resolveCommandValue(value, context).pipe(Effect.map((resolved) => [name, resolved] as const)),
  ).pipe(Effect.map(Object.fromEntries));

const resolveScalarRecord = (
  values: Readonly<Record<string, ToolingVarLiteral>>,
  context: ExpressionContext,
): Effect.Effect<Readonly<Record<string, ToolingVarLiteral>>, ToolingStepExpressionError> =>
  Effect.forEach(Object.entries(values), ([name, value]) =>
    resolveLiteral(value, context).pipe(
      Effect.map(
        (resolved) =>
          [
            name,
            typeof resolved === "string" || typeof resolved === "number" || typeof resolved === "boolean"
              ? resolved
              : String(resolved),
          ] as const,
      ),
    ),
  ).pipe(Effect.map(Object.fromEntries));

export const resolveToolingTaskShape = (
  task: ToolingTaskShape,
  context: ExpressionContext,
): Effect.Effect<ToolingTaskShape, ToolingStepExpressionError> =>
  Effect.gen(function* () {
    const cmd =
      task.cmd === undefined
        ? undefined
        : typeof task.cmd === "string"
          ? yield* resolveString(task.cmd, context)
          : yield* Effect.forEach(task.cmd, (value) => resolveString(value, context));
    const cmds =
      task.cmds === undefined
        ? undefined
        : yield* Effect.forEach(task.cmds, (value) => resolveString(value, context));
    const service = task.service === undefined ? undefined : yield* resolveString(task.service, context);
    const dir =
      task.dir === undefined ? undefined : PortablePath.make(yield* resolveString(String(task.dir), context));
    const env = task.env === undefined ? undefined : yield* resolveScalarRecord(task.env, context);
    return {
      ...task,
      ...(cmd === undefined ? {} : { cmd }),
      ...(cmds === undefined ? {} : { cmds }),
      ...(service === undefined ? {} : { service }),
      ...(dir === undefined ? {} : { dir }),
      ...(env === undefined ? {} : { env }),
    };
  });

const conditionError = (condition: string, cause?: unknown) =>
  new ToolingStepConditionError({
    message: `Tooling step condition must evaluate to a boolean: ${condition}`,
    condition,
    remediation: "Use a boolean literal or a whole expression that evaluates to a boolean.",
    ...(cause === undefined ? {} : { cause }),
  });

export const conditionAllows = (
  condition: ToolingStepLeaf["condition"],
  context: ExpressionContext,
): Effect.Effect<boolean, ToolingStepConditionError> => {
  if (condition === undefined || typeof condition === "boolean") return Effect.succeed(condition ?? true);
  return resolve(condition, context).pipe(
    Effect.mapError((cause) => conditionError(condition, cause)),
    Effect.flatMap((value) =>
      typeof value === "boolean" ? Effect.succeed(value) : Effect.fail(conditionError(condition)),
    ),
  );
};

const resolveCmd = (leaf: ToolingCmdStepLeaf, context: ExpressionContext) =>
  Effect.gen(function* () {
    const command = yield* resolveString(leaf.command, context);
    const service = leaf.service === undefined ? undefined : yield* resolveString(leaf.service, context);
    const user = leaf.user === undefined ? undefined : yield* resolveString(leaf.user, context);
    const dir =
      leaf.dir === undefined ? undefined : PortablePath.make(yield* resolveString(leaf.dir, context));
    const env = leaf.env === undefined ? undefined : yield* resolveScalarRecord(leaf.env, context);
    return {
      kind: "cmd" as const,
      authoredIndex: leaf.authoredIndex,
      command,
      silent: leaf.silent,
      ignoreError: leaf.ignoreError,
      ...(service === undefined ? {} : { service }),
      ...(user === undefined ? {} : { user }),
      ...(dir === undefined ? {} : { dir }),
      ...(env === undefined ? {} : { env }),
    };
  });

const resolveTask = (leaf: ToolingTaskStepLeaf, context: ExpressionContext) =>
  Effect.gen(function* () {
    const task = yield* resolveString(leaf.task, context);
    const overlay = yield* resolveRecord(leaf.vars ?? {}, context);
    const vars = { ...(context.vars ?? {}), ...overlay };
    return {
      leaf: {
        kind: "task" as const,
        authoredIndex: leaf.authoredIndex,
        task,
        vars,
        silent: leaf.silent,
        ignoreError: leaf.ignoreError,
      },
      context: { ...context, vars },
    };
  });

const resolveCommand = (leaf: ToolingCommandStepLeaf, context: ExpressionContext) =>
  Effect.gen(function* () {
    const command = yield* resolveString(leaf.command, context);
    const flags = yield* resolveCommandRecord(leaf.flags, context);
    const args = yield* resolveCommandRecord(leaf.args, context);
    const raw = yield* Effect.forEach(leaf.raw, (value) => resolveString(value, context));
    return {
      kind: "command" as const,
      authoredIndex: leaf.authoredIndex,
      command,
      flags,
      args,
      raw,
      silent: leaf.silent,
      ignoreError: leaf.ignoreError,
    };
  });

export const resolveLeaf = (leaf: ToolingStepLeaf, context: ExpressionContext) => {
  switch (leaf.kind) {
    case "cmd":
      return resolveCmd(leaf, context).pipe(Effect.map((resolved) => ({ leaf: resolved, context })));
    case "task":
      return resolveTask(leaf, context);
    case "command":
      return resolveCommand(leaf, context).pipe(Effect.map((resolved) => ({ leaf: resolved, context })));
  }
};

export const runToolingStepProgram = <E, A>(
  program: ToolingStepProgram,
  context: ExpressionContext,
  runners: ToolingStepRunners<E, A>,
) => runToolingStepProgramWith(program, context, runners, { conditionAllows, resolveLeaf });

export type {
  ResolvedToolingCmdStepLeaf,
  ResolvedToolingCommandStepLeaf,
  ResolvedToolingStepLeaf,
  ResolvedToolingTaskStepLeaf,
  ToolingStepExpressionError,
  ToolingStepRunners,
} from "./step-runner-types.ts";
