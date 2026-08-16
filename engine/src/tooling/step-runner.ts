import { Effect, Exit } from "effect";

import { type LandofileExpressionParseError, ToolingStepConditionError } from "@lando/sdk/errors";
import {
  type ExpressionContext,
  type LandofileExpressionEvaluationError,
  evaluateTemplate,
  parseExpression,
} from "@lando/sdk/expressions";
import { PortablePath, type ToolingTaskShape, type ToolingVarLiteral } from "@lando/sdk/schema";

import type {
  ToolingCmdStepLeaf,
  ToolingCommandStepLeaf,
  ToolingStepIteration,
  ToolingStepLeaf,
  ToolingStepNode,
  ToolingStepProgram,
  ToolingStepSelector,
  ToolingTaskStepLeaf,
} from "./step-program.ts";

const EXPRESSION_FILE = "<tooling-step>";

interface ResolvedLeafBase {
  readonly authoredIndex: number;
  readonly silent: boolean;
  readonly ignoreError: boolean;
}

export interface ResolvedToolingCmdStepLeaf extends ResolvedLeafBase {
  readonly kind: "cmd";
  readonly command: string;
  readonly service?: string;
  readonly env?: Readonly<Record<string, ToolingVarLiteral>>;
  readonly user?: string;
  readonly dir?: PortablePath;
}

export interface ResolvedToolingTaskStepLeaf extends ResolvedLeafBase {
  readonly kind: "task";
  readonly task: string;
  readonly vars: Readonly<Record<string, unknown>>;
}

export interface ResolvedToolingCommandStepLeaf extends ResolvedLeafBase {
  readonly kind: "command";
  readonly command: string;
  readonly flags: Readonly<Record<string, ToolingVarLiteral>>;
  readonly args: Readonly<Record<string, ToolingVarLiteral>>;
  readonly raw: ReadonlyArray<string>;
}

export type ResolvedToolingStepLeaf =
  | ResolvedToolingCmdStepLeaf
  | ResolvedToolingTaskStepLeaf
  | ResolvedToolingCommandStepLeaf;

export interface ToolingStepPresentation<A> {
  readonly leaf: ResolvedToolingStepLeaf;
  readonly context: ExpressionContext;
  readonly result: A;
}

export interface ToolingStepRunners<E, A> {
  readonly runCmd: (leaf: ResolvedToolingCmdStepLeaf, context: ExpressionContext) => Effect.Effect<A, E>;
  readonly runTask: (leaf: ResolvedToolingTaskStepLeaf, context: ExpressionContext) => Effect.Effect<A, E>;
  readonly runCommand: (
    leaf: ResolvedToolingCommandStepLeaf,
    context: ExpressionContext,
  ) => Effect.Effect<A, E>;
  readonly present: (presentation: ToolingStepPresentation<A>) => Effect.Effect<void, E>;
  readonly mapLeafError?: (leaf: ToolingStepLeaf, error: unknown) => E;
}

type ToolingStepExpressionError = LandofileExpressionParseError | LandofileExpressionEvaluationError;

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

const conditionAllows = (
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
    const flags = yield* resolveScalarRecord(leaf.flags, context);
    const args = yield* resolveScalarRecord(leaf.args, context);
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

const resolveLeaf = (leaf: ToolingStepLeaf, context: ExpressionContext) => {
  switch (leaf.kind) {
    case "cmd":
      return resolveCmd(leaf, context).pipe(Effect.map((resolved) => ({ leaf: resolved, context })));
    case "task":
      return resolveTask(leaf, context);
    case "command":
      return resolveCommand(leaf, context).pipe(Effect.map((resolved) => ({ leaf: resolved, context })));
  }
};

const matrixItems = (axes: Extract<ToolingStepSelector, { readonly kind: "matrix" }>["axes"]) => {
  let items: ReadonlyArray<Readonly<Record<string, ToolingVarLiteral>>> = [{}];
  for (const [name, values] of axes) {
    items = items.flatMap((item) => values.map((value) => ({ ...item, [name]: value })));
  }
  return items;
};

const selectorIterations = (
  selector: ToolingStepSelector,
  context: ExpressionContext,
): Effect.Effect<ReadonlyArray<ToolingStepIteration>> => {
  if (selector.kind === "list") {
    return Effect.succeed(
      selector.values.map((item, key) => ({ context: { ...context, item, key }, item, key })),
    );
  }
  if (selector.kind === "matrix") {
    return Effect.succeed(
      matrixItems(selector.axes).map((item, key) => ({ context: { ...context, item, key }, item, key })),
    );
  }
  const selected = context.vars?.[selector.name];
  if (Array.isArray(selected)) {
    return Effect.succeed(selected.map((item, key) => ({ context: { ...context, item, key }, item, key })));
  }
  if (typeof selected === "object" && selected !== null) {
    return Effect.succeed(
      Object.entries(selected)
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([key, item]) => ({ context: { ...context, item, key }, item, key })),
    );
  }
  return Effect.succeed([]);
};

const executeResolved = <E, A>(
  leaf: ResolvedToolingStepLeaf,
  context: ExpressionContext,
  runners: ToolingStepRunners<E, A>,
): Effect.Effect<void, E> => {
  const run = (() => {
    switch (leaf.kind) {
      case "cmd":
        return runners.runCmd(leaf, context);
      case "task":
        return runners.runTask(leaf, context);
      case "command":
        return runners.runCommand(leaf, context);
    }
  })();
  const presented = run.pipe(
    Effect.flatMap((result) => (leaf.silent ? Effect.void : runners.present({ leaf, context, result }))),
  );
  return leaf.ignoreError ? presented.pipe(Effect.catchAll(() => Effect.void)) : presented;
};

export const runToolingStepProgram = <E, A>(
  program: ToolingStepProgram,
  context: ExpressionContext,
  runners: ToolingStepRunners<E, A>,
): Effect.Effect<void, E | ToolingStepConditionError | ToolingStepExpressionError> =>
  Effect.uninterruptibleMask((restore) =>
    Effect.gen(function* () {
      const deferred: Array<Effect.Effect<void, E | ToolingStepConditionError | ToolingStepExpressionError>> =
        [];
      const executeLeaf = (leaf: ToolingStepLeaf, leafContext: ExpressionContext, checkCondition: boolean) =>
        Effect.gen(function* () {
          if (checkCondition && !(yield* conditionAllows(leaf.condition, leafContext))) return;
          const resolved = yield* resolveLeaf(leaf, leafContext);
          yield* executeResolved(resolved.leaf, resolved.context, runners);
        }).pipe(
          Effect.catchAll((error) =>
            runners.mapLeafError === undefined
              ? Effect.fail(error)
              : Effect.fail(runners.mapLeafError(leaf, error)),
          ),
        );
      const executeNode = (
        node: ToolingStepNode,
        nodeContext: ExpressionContext,
      ): Effect.Effect<void, E | ToolingStepConditionError | ToolingStepExpressionError> => {
        if (node.kind === "leaf") return executeLeaf(node.leaf, nodeContext, true);
        if (node.kind === "defer") {
          return conditionAllows(node.leaf.condition, nodeContext).pipe(
            Effect.flatMap((allowed) =>
              Effect.sync(() => {
                if (allowed) deferred.push(executeLeaf(node.leaf, nodeContext, false));
              }),
            ),
          );
        }
        return selectorIterations(node.selector, nodeContext).pipe(
          Effect.flatMap((iterations) =>
            Effect.forEach(
              iterations,
              ({ context: iterationContext }) => executeNode(node.body, iterationContext),
              { discard: true },
            ),
          ),
        );
      };
      const bodyExit = yield* Effect.exit(
        restore(Effect.forEach(program.nodes, (node) => executeNode(node, context), { discard: true })),
      );
      let deferredFailure:
        | Exit.Exit<void, E | ToolingStepConditionError | ToolingStepExpressionError>
        | undefined;
      for (const finalizer of deferred.reverse()) {
        const exit = yield* Effect.exit(finalizer);
        if (deferredFailure === undefined && Exit.isFailure(exit)) deferredFailure = exit;
      }
      if (Exit.isFailure(bodyExit)) return yield* Effect.failCause(bodyExit.cause);
      if (deferredFailure !== undefined && Exit.isFailure(deferredFailure)) {
        return yield* Effect.failCause(deferredFailure.cause);
      }
    }),
  );
