import { Effect, Exit } from "effect";

import type { ToolingStepConditionError } from "@lando/sdk/errors";
import type { ExpressionContext } from "@lando/sdk/expressions";
import type { ToolingVarLiteral } from "@lando/sdk/schema";

import type {
  ToolingStepIteration,
  ToolingStepLeaf,
  ToolingStepNode,
  ToolingStepProgram,
  ToolingStepSelector,
} from "./step-program.ts";
import type {
  ResolvedToolingStepLeaf,
  ToolingStepExpressionError,
  ToolingStepRunners,
} from "./step-runner-types.ts";

interface StepExecutionDependencies {
  readonly conditionAllows: (
    condition: ToolingStepLeaf["condition"],
    context: ExpressionContext,
  ) => Effect.Effect<boolean, ToolingStepConditionError>;
  readonly resolveLeaf: (
    leaf: ToolingStepLeaf,
    context: ExpressionContext,
  ) => Effect.Effect<
    { readonly leaf: ResolvedToolingStepLeaf; readonly context: ExpressionContext },
    ToolingStepExpressionError
  >;
}

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
  switch (selector.kind) {
    case "list":
      return Effect.succeed(
        selector.values.map((item, key) => ({ context: { ...context, item, key }, item, key })),
      );
    case "matrix":
      return Effect.succeed(
        matrixItems(selector.axes).map((item, key) => ({ context: { ...context, item, key }, item, key })),
      );
    case "var": {
      const selected = context.vars?.[selector.name];
      if (Array.isArray(selected)) {
        return Effect.succeed(
          selected.map((item, key) => ({ context: { ...context, item, key }, item, key })),
        );
      }
      if (typeof selected === "object" && selected !== null) {
        return Effect.succeed(
          Object.entries(selected)
            .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
            .map(([key, item]) => ({ context: { ...context, item, key }, item, key })),
        );
      }
      return Effect.succeed([]);
    }
  }
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

export const runToolingStepProgramWith = <E, A>(
  program: ToolingStepProgram,
  context: ExpressionContext,
  runners: ToolingStepRunners<E, A>,
  dependencies: StepExecutionDependencies,
): Effect.Effect<void, E | ToolingStepConditionError | ToolingStepExpressionError> =>
  Effect.uninterruptibleMask((restore) =>
    Effect.gen(function* () {
      const deferred: Array<Effect.Effect<void, E | ToolingStepConditionError | ToolingStepExpressionError>> =
        [];
      const executeLeaf = (leaf: ToolingStepLeaf, leafContext: ExpressionContext, checkCondition: boolean) =>
        Effect.gen(function* () {
          if (checkCondition && !(yield* dependencies.conditionAllows(leaf.condition, leafContext))) return;
          const resolved = yield* dependencies.resolveLeaf(leaf, leafContext);
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
          return dependencies.conditionAllows(node.leaf.condition, nodeContext).pipe(
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
