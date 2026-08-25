import { Effect } from "effect";

import {
  type ProgressEmitter,
  type TaskSpec,
  type TaskTreeController,
  type TaskTreeSummaries,
  makeTaskTree,
  runWithTaskTree,
} from "@lando/sdk/task-progress";

import { applyTreeId, startGlobalTreeId, startRoutesTreeId } from "./start-progress.ts";

export const withApplyProgress = <A extends { readonly name: string; readonly state: string }, E, R>(input: {
  readonly events: ProgressEmitter;
  readonly plan: { readonly id: string; readonly name: string };
  readonly services: ReadonlyArray<{ readonly name: unknown }>;
  readonly work: Effect.Effect<ReadonlyArray<A>, E, R>;
}): Effect.Effect<ReadonlyArray<A>, E, R> => {
  const tree = makeTaskTree(input.events, {
    parentId: applyTreeId(String(input.plan.id)),
    label: `Apply ${input.plan.name}`,
    children: input.services.map((service) => ({
      id: String(service.name),
      label: `Apply service ${String(service.name)}`,
    })),
    mode: "list",
  });
  return runWithTaskTree(
    tree,
    (active) =>
      Effect.gen(function* () {
        for (const service of input.services) {
          yield* active.startTask(String(service.name));
        }
        const inspected = yield* input.work;
        for (const service of inspected) {
          yield* active.completeTask(service.name, `${service.name} (${service.state})`);
        }
        return inspected;
      }),
    {
      success: `${input.plan.name} applied`,
      failure: `${input.plan.name} apply failed`,
      interrupt: `${input.plan.name} apply interrupted`,
    },
  );
};

const runPrefixedPhase = <A, E, R>(
  events: ProgressEmitter,
  args: {
    readonly parentId: string;
    readonly label: string;
    readonly children: ReadonlyArray<TaskSpec>;
    readonly summaries: TaskTreeSummaries;
    readonly work: (tree: TaskTreeController) => Effect.Effect<A, E, R>;
  },
): Effect.Effect<A, E, R> =>
  runWithTaskTree(
    makeTaskTree(events, {
      parentId: args.parentId,
      label: args.label,
      children: args.children,
      prefixChildIds: true,
    }),
    args.work,
    args.summaries,
  );

export const withGlobalStartProgress = <A, E, R>(input: {
  readonly events: ProgressEmitter;
  readonly plan: { readonly id: string; readonly name: string };
  readonly serviceIds: ReadonlyArray<string>;
  readonly work: Effect.Effect<A, E, R>;
}): Effect.Effect<A, E, R> =>
  runPrefixedPhase(input.events, {
    parentId: startGlobalTreeId(String(input.plan.id)),
    label: `Global services ${input.plan.name}`,
    children: input.serviceIds.map((id) => ({ id, label: `Start global ${id}` })),
    summaries: {
      success: `${input.plan.name} global services ready`,
      failure: `${input.plan.name} global services failed`,
      interrupt: `${input.plan.name} global services interrupted`,
    },
    work: (tree) =>
      Effect.gen(function* () {
        for (const id of input.serviceIds) yield* tree.startTask(id);
        const result = yield* input.work;
        for (const id of input.serviceIds) yield* tree.completeTask(id);
        return result;
      }),
  });

export const withRoutesStartProgress = <A, E, R>(input: {
  readonly events: ProgressEmitter;
  readonly plan: { readonly id: string; readonly name: string };
  readonly work: Effect.Effect<A, E, R>;
}): Effect.Effect<A, E, R> =>
  runPrefixedPhase(input.events, {
    parentId: startRoutesTreeId(String(input.plan.id)),
    label: `Routes ${input.plan.name}`,
    children: [{ id: "apply", label: "Apply proxy routes" }],
    summaries: {
      success: `${input.plan.name} routes applied`,
      failure: `${input.plan.name} routes failed`,
      interrupt: `${input.plan.name} routes interrupted`,
    },
    work: (tree) =>
      Effect.gen(function* () {
        yield* tree.startTask("apply");
        const result = yield* input.work;
        yield* tree.completeTask("apply");
        return result;
      }),
  });
