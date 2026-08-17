import { Data, Effect, Either } from "effect";

import { ToolingCompileError, ToolingStepSelectorUnavailableError } from "@lando/sdk/errors";
import { parseExpressionEither } from "@lando/sdk/expressions";
import type { EventForSelector, EventStep, ToolingVarLiteral } from "@lando/sdk/schema";

import type {
  ToolingCmdStepLeaf,
  ToolingCommandStepLeaf,
  ToolingStepDeferNode,
  ToolingStepLeaf,
  ToolingStepLeafNode,
  ToolingStepNode,
  ToolingStepProgram,
  ToolingStepSelector,
  ToolingTaskStepLeaf,
} from "./step-program.ts";

export class EventStepCompileError extends Data.TaggedError("EventStepCompileError")<{
  readonly message: string;
  readonly authoredIndex: number;
  readonly kind: ToolingStepLeaf["kind"];
  readonly cause: ToolingStepSelectorUnavailableError | ToolingCompileError;
}> {}

const leafNode = (leaf: ToolingStepLeaf): ToolingStepLeafNode => ({
  kind: "leaf",
  authoredIndex: leaf.authoredIndex,
  leaf,
});

const deferNode = (leaf: ToolingStepLeaf): ToolingStepDeferNode => ({
  kind: "defer",
  authoredIndex: leaf.authoredIndex,
  leaf,
});

const shared = (step: Exclude<EventStep, string>, authoredIndex: number) => ({
  authoredIndex,
  ...(step.if === undefined ? {} : { condition: step.if }),
  silent: step.silent ?? false,
  ignoreError: "ignoreError" in step ? (step.ignoreError ?? false) : false,
});

const cmdLeaf = (
  step:
    | Extract<Exclude<EventStep, string>, { readonly cmd: string }>
    | Extract<Exclude<EventStep, string>, { readonly defer: string }>,
  authoredIndex: number,
): ToolingCmdStepLeaf => ({
  kind: "cmd",
  command: "cmd" in step && step.cmd !== undefined ? step.cmd : step.defer,
  ...shared(step, authoredIndex),
  ...("service" in step && step.service !== undefined ? { service: step.service } : {}),
  ...("dir" in step && step.dir !== undefined ? { dir: String(step.dir) } : {}),
  ...("env" in step && step.env !== undefined ? { env: step.env } : {}),
  ...("user" in step && step.user !== undefined ? { user: step.user } : {}),
});

const taskLeaf = (
  step: Extract<Exclude<EventStep, string>, { readonly task: string }>,
  authoredIndex: number,
): ToolingTaskStepLeaf => ({
  kind: "task",
  task: step.task,
  ...shared(step, authoredIndex),
  ...(step.vars === undefined ? {} : { vars: step.vars }),
});

const commandLeaf = (
  step: Extract<Exclude<EventStep, string>, { readonly command: string }>,
  authoredIndex: number,
): ToolingCommandStepLeaf => ({
  kind: "command",
  command: step.command,
  flags: step.flags ?? {},
  args: step.args ?? {},
  raw: step.raw ?? [],
  ...shared(step, authoredIndex),
});

const compileLeaf = (step: EventStep, authoredIndex: number): ToolingStepLeaf => {
  if (typeof step === "string") {
    return { kind: "cmd", authoredIndex, command: step, silent: false, ignoreError: false };
  }
  if ("task" in step && step.task !== undefined) return taskLeaf(step, authoredIndex);
  if ("command" in step && step.command !== undefined) return commandLeaf(step, authoredIndex);
  return cmdLeaf(step, authoredIndex);
};

const unavailableSelector = (selector: "sources" | "generates") =>
  new ToolingStepSelectorUnavailableError({
    message: `The ${selector} selector is unavailable for root event tooling steps.`,
    selector,
    remediation: "Use a literal, variable, or matrix selector for root event programs.",
  });

const isLiteralSelector = (selector: EventForSelector): selector is ReadonlyArray<ToolingVarLiteral> =>
  Array.isArray(selector);

const compileSelector = (
  selector: EventForSelector,
): Effect.Effect<ToolingStepSelector, ToolingStepSelectorUnavailableError> => {
  if (isLiteralSelector(selector)) return Effect.succeed({ kind: "list", values: selector });
  if (selector.sources === true) return Effect.fail(unavailableSelector("sources"));
  if (selector.generates === true) return Effect.fail(unavailableSelector("generates"));
  if (selector.var !== undefined) return Effect.succeed({ kind: "var", name: selector.var });
  return Effect.succeed({ kind: "matrix", axes: Object.entries(selector.matrix) });
};

const compileNode = (
  step: EventStep,
  authoredIndex: number,
): Effect.Effect<ToolingStepNode, ToolingStepSelectorUnavailableError> => {
  if (typeof step !== "string" && "for" in step && step.for !== undefined) {
    return compileSelector(step.for).pipe(
      Effect.map((selector) => {
        const body =
          "defer" in step && step.defer !== undefined
            ? deferNode(compileLeaf(step, authoredIndex))
            : leafNode(compileLeaf(step, authoredIndex));
        return { kind: "for", authoredIndex, selector, body };
      }),
    );
  }
  if (typeof step !== "string" && "defer" in step && step.defer !== undefined) {
    return Effect.succeed(deferNode(compileLeaf(step, authoredIndex)));
  }
  return Effect.succeed(leafNode(compileLeaf(step, authoredIndex)));
};

/** Non-string scalars are compile-time literals; strings are dynamic when any segment is not LiteralSegment. */
const commandInputHasDynamicExpression = (
  value: unknown,
  tool: string,
): Effect.Effect<boolean, ToolingCompileError> => {
  if (typeof value !== "string") return Effect.succeed(false);
  const parsed = parseExpressionEither(value, { filePath: "<event-step-command>" });
  if (Either.isLeft(parsed)) {
    return Effect.fail(
      new ToolingCompileError({
        message: parsed.left.message,
        tool,
        remediation: parsed.left.remediation,
        cause: parsed.left,
      }),
    );
  }
  return Effect.succeed(parsed.right.segments.some((segment) => segment.kind !== "LiteralSegment"));
};

const commandLeafHasDynamicInput = (
  leaf: ToolingCommandStepLeaf,
): Effect.Effect<boolean, ToolingCompileError> => {
  const values: ReadonlyArray<unknown> = [
    leaf.command,
    ...Object.values(leaf.flags),
    ...Object.values(leaf.args),
    ...leaf.raw,
  ];
  return Effect.reduce(values, false, (found, value) =>
    commandInputHasDynamicExpression(value, leaf.command).pipe(Effect.map((dynamic) => found || dynamic)),
  );
};

export const compileEventStepProgram = (
  steps: ReadonlyArray<EventStep>,
  validateCommand?: (leaf: ToolingCommandStepLeaf) => Effect.Effect<void, ToolingCompileError>,
): Effect.Effect<ToolingStepProgram, EventStepCompileError> =>
  Effect.forEach(steps, (step, authoredIndex) =>
    compileNode(step, authoredIndex).pipe(
      Effect.tap((node) => {
        const leaf = node.kind === "for" ? node.body.leaf : node.leaf;
        if (leaf.kind !== "command" || validateCommand === undefined) return Effect.void;
        return commandLeafHasDynamicInput(leaf).pipe(
          Effect.flatMap((dynamic) => (dynamic ? Effect.void : validateCommand(leaf))),
        );
      }),
      Effect.mapError(
        (cause) =>
          new EventStepCompileError({
            message: cause.message,
            authoredIndex,
            kind: compileLeaf(step, authoredIndex).kind,
            cause,
          }),
      ),
    ),
  ).pipe(Effect.map((nodes) => ({ nodes })));

export const compileSimpleToolingTaskProgram = (name: string): ToolingStepProgram => ({
  nodes: [
    leafNode({
      kind: "task",
      authoredIndex: 0,
      task: name,
      silent: false,
      ignoreError: false,
    }),
  ],
});
