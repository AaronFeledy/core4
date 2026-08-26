import type { Effect } from "effect";

import {
  type ProgressEmitter,
  type TaskSpec,
  type TaskTreeController,
  makeTaskTree,
  runWithTaskTree,
} from "@lando/sdk/task-progress";

export const destroyTreeId = (planId: string): string => `destroy-${planId}`;

export interface DestroyProgressChildren {
  readonly fileSync: boolean;
  readonly proxy: boolean;
  readonly snapshots: boolean;
}

export const withDestroyProgress = <A, E, R>(input: {
  readonly events: ProgressEmitter;
  readonly plan: { readonly id: string; readonly name: string };
  readonly children: DestroyProgressChildren;
  readonly work: (tree: TaskTreeController) => Effect.Effect<A, E, R>;
}): Effect.Effect<A, E, R> => {
  const children: TaskSpec[] = [
    ...(input.children.fileSync ? [{ id: "file-sync", label: "Stop file sync" }] : []),
    { id: "provider", label: "Destroy services" },
    { id: "host-proxy", label: "Clean host-proxy state" },
    ...(input.children.proxy ? [{ id: "routes", label: "Remove proxy routes" }] : []),
    ...(input.children.snapshots ? [{ id: "snapshots", label: "Remove snapshots" }] : []),
  ];
  return runWithTaskTree(
    makeTaskTree(input.events, {
      parentId: destroyTreeId(String(input.plan.id)),
      label: `Destroy ${input.plan.name}`,
      children,
      prefixChildIds: true,
      mode: "list",
    }),
    input.work,
    {
      success: `${input.plan.name} destroyed`,
      failure: `${input.plan.name} destroy failed`,
      interrupt: `${input.plan.name} destroy interrupted`,
    },
  );
};
