import { Effect } from "effect";

import { ToolingStepSelectorUnavailableError } from "@lando/sdk/errors";
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
  args: step.args ?? [],
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

export const compileEventStepProgram = (
  steps: ReadonlyArray<EventStep>,
): Effect.Effect<ToolingStepProgram, ToolingStepSelectorUnavailableError> =>
  Effect.forEach(steps, compileNode).pipe(Effect.map((nodes) => ({ nodes })));

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
