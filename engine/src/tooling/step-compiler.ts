import { Effect, Schema } from "effect";

import type { InvocationProgram } from "@lando/landofile/compiled-sites";
import { ToolingCompileError, ToolingStepSelectorUnavailableError } from "@lando/sdk/errors";
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

export class EventStepCompileError extends Schema.TaggedError<EventStepCompileError>()(
  "EventStepCompileError",
  {
    message: Schema.String,
    authoredIndex: Schema.Number,
    source: Schema.optionalKey(Schema.Literals(["host", "project"])),
    kind: Schema.Literals(["cmd", "task", "command"]),
    cause: Schema.Union([ToolingStepSelectorUnavailableError, ToolingCompileError]),
  },
) {}

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

const shared = (step: Exclude<EventStep, string>, authoredIndex: number, source?: "host" | "project") => ({
  authoredIndex,
  ...(source === undefined ? {} : { source }),
  ...(step.if === undefined ? {} : { condition: step.if }),
  silent: step.silent ?? false,
  ignoreError: "ignoreError" in step ? (step.ignoreError ?? false) : false,
});

const cmdLeaf = (
  step:
    | Extract<Exclude<EventStep, string>, { readonly cmd: string }>
    | Extract<Exclude<EventStep, string>, { readonly defer: string }>,
  authoredIndex: number,
  source?: "host" | "project",
): ToolingCmdStepLeaf => ({
  kind: "cmd",
  command: "cmd" in step && step.cmd !== undefined ? step.cmd : step.defer,
  ...shared(step, authoredIndex, source),
  ...("service" in step && step.service !== undefined ? { service: step.service } : {}),
  ...("dir" in step && step.dir !== undefined ? { dir: String(step.dir) } : {}),
  ...("env" in step && step.env !== undefined ? { env: step.env } : {}),
  ...("user" in step && step.user !== undefined ? { user: step.user } : {}),
});

const taskLeaf = (
  step: Extract<Exclude<EventStep, string>, { readonly task: string }>,
  authoredIndex: number,
  source?: "host" | "project",
): ToolingTaskStepLeaf => ({
  kind: "task",
  task: step.task,
  ...shared(step, authoredIndex, source),
  ...(step.vars === undefined ? {} : { vars: step.vars }),
});

const commandLeaf = (
  step: Extract<Exclude<EventStep, string>, { readonly command: string }>,
  authoredIndex: number,
  source?: "host" | "project",
): ToolingCommandStepLeaf => ({
  kind: "command",
  command: step.command,
  flags: step.flags ?? {},
  args: step.args ?? {},
  raw: step.raw ?? [],
  ...shared(step, authoredIndex, source),
});

const compileLeaf = (
  step: EventStep,
  authoredIndex: number,
  source?: "host" | "project",
): ToolingStepLeaf => {
  if (typeof step === "string") {
    return {
      kind: "cmd",
      authoredIndex,
      command: step,
      silent: false,
      ignoreError: false,
      ...(source === undefined ? {} : { source }),
    };
  }
  if ("task" in step && step.task !== undefined) return taskLeaf(step, authoredIndex, source);
  if ("command" in step && step.command !== undefined) return commandLeaf(step, authoredIndex, source);
  return cmdLeaf(step, authoredIndex, source);
};

const unavailableSelector = (selector: "sources" | "generates") =>
  new ToolingStepSelectorUnavailableError({
    message: `The ${selector} selector is unavailable for root event tooling steps.`,
    selector,
    remediation: "Use a literal, variable, or matrix selector for root event programs.",
  });

const isLiteralSelector = (selector: EventForSelector): selector is ReadonlyArray<ToolingVarLiteral> =>
  Array.isArray(selector);

export const compileSelector = (
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
  source?: "host" | "project",
): Effect.Effect<ToolingStepNode, ToolingStepSelectorUnavailableError> => {
  if (typeof step !== "string" && "for" in step && step.for !== undefined) {
    return compileSelector(step.for).pipe(
      Effect.map((selector) => {
        const body =
          "defer" in step && step.defer !== undefined
            ? deferNode(compileLeaf(step, authoredIndex, source))
            : leafNode(compileLeaf(step, authoredIndex, source));
        return { kind: "for", authoredIndex, selector, body };
      }),
    );
  }
  if (typeof step !== "string" && "defer" in step && step.defer !== undefined) {
    return Effect.succeed(deferNode(compileLeaf(step, authoredIndex, source)));
  }
  return Effect.succeed(leafNode(compileLeaf(step, authoredIndex, source)));
};

export interface EventStepIdentity {
  readonly authoredIndex: number;
  readonly source?: "host" | "project";
  readonly invocationSites?: InvocationProgram;
}

export const compileEventStepProgram = (
  steps: ReadonlyArray<EventStep>,
  validateCommand?: (leaf: ToolingCommandStepLeaf) => Effect.Effect<void, ToolingCompileError>,
  identities?: ReadonlyArray<EventStepIdentity>,
): Effect.Effect<ToolingStepProgram, EventStepCompileError> =>
  Effect.forEach(steps, (step, index) => {
    const identity = identities?.[index] ?? { authoredIndex: index };
    const node = Effect.succeed(identity.invocationSites ?? []).pipe(
      Effect.flatMap(
        (
          sites,
        ): Effect.Effect<ToolingStepNode, ToolingCompileError | ToolingStepSelectorUnavailableError> => {
          const predicate = sites.find(
            (site) =>
              site.path.length === 1 &&
              site.path[0] === "if" &&
              site.template.segments.some((segment) => segment.kind === "InterpolationSegment"),
          );
          if (typeof step !== "string" && typeof step.if === "string" && predicate === undefined)
            return Effect.fail(
              new ToolingCompileError({
                message: "Compiled event step condition must be a boolean.",
                tool: "event",
              }),
            );
          return compileNode(step, identity.authoredIndex, identity.source).pipe(
            Effect.map((node): ToolingStepNode => {
              const leaf = node.kind === "for" ? node.body.leaf : node.leaf;
              const invocationSites = sites
                .filter((site) => site.path[0] !== "if" && site.path[0] !== "for")
                .map((site) => {
                  const [field, ...rest] = site.path;
                  return {
                    ...site,
                    path:
                      field === undefined
                        ? ["command"]
                        : [field === "cmd" || field === "defer" ? "command" : field, ...rest],
                  };
                });
              const annotated = {
                ...leaf,
                invocationSites,
                ...(predicate === undefined ? {} : { condition: predicate }),
              };
              if (node.kind === "for")
                return {
                  ...node,
                  body: { ...node.body, leaf: annotated },
                  ...(typeof step !== "string" && "for" in step && step.for !== undefined
                    ? {
                        selectorInvocation: {
                          value: step.for,
                          sites: sites
                            .filter((site) => site.path[0] === "for")
                            .map((site) => ({ ...site, path: site.path.slice(1) })),
                        },
                      }
                    : {}),
                };
              return { ...node, leaf: annotated };
            }),
          );
        },
      ),
    );
    return node.pipe(
      Effect.tap((node) => {
        const leaf = node.kind === "for" ? node.body.leaf : node.leaf;
        if (leaf.kind !== "command" || validateCommand === undefined) return Effect.void;
        return leaf.invocationSites?.some(
          (site) =>
            ["command", "flags", "args", "raw"].includes(String(site.path[0])) &&
            site.template.segments.some(
              (segment) => segment.kind !== "LiteralSegment" && segment.kind !== "CommentSegment",
            ),
        )
          ? Effect.void
          : validateCommand(leaf);
      }),
      Effect.mapError(
        (cause) =>
          new EventStepCompileError({
            message: cause.message,
            authoredIndex: identity.authoredIndex,
            ...(identity.source === undefined ? {} : { source: identity.source }),
            kind: compileLeaf(step, identity.authoredIndex, identity.source).kind,
            cause,
          }),
      ),
    );
  }).pipe(Effect.map((nodes) => ({ nodes })));

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
