import { Effect } from "effect";

import type { AbsolutePath, AppPlan, ServicePlan } from "@lando/sdk/schema";
import { type ProgressEmitter, makeTaskTree } from "@lando/sdk/task-progress";

export interface BuildTaskProgress {
  readonly parentId: string;
  readonly startTree: Effect.Effect<void>;
  readonly startTask: (service: ServicePlan, transcriptPath: AbsolutePath) => Effect.Effect<void>;
  readonly completeTask: (service: ServicePlan, summary: string) => Effect.Effect<void>;
  readonly failTask: (service: ServicePlan) => Effect.Effect<void>;
  readonly abortTask: (service: ServicePlan, transcriptPath: AbsolutePath) => Effect.Effect<void>;
  readonly unsettledServices: () => ReadonlyArray<ServicePlan>;
  readonly completeTree: Effect.Effect<void>;
  readonly failTree: Effect.Effect<void>;
}

export const makeBuildTaskProgress = (events: ProgressEmitter, plan: AppPlan): BuildTaskProgress => {
  const services = Object.values(plan.services);
  const parentId = `build-artifact-${String(plan.id)}`;
  const settled = new Set<string>();
  const tree = makeTaskTree(events, {
    parentId,
    label: `Building ${plan.name}`,
    children: services.map((service) => ({
      id: String(service.name),
      label: `Build ${String(service.name)}`,
    })),
    mode: "list",
  });
  const markSettled = (service: ServicePlan) =>
    Effect.sync(() => {
      settled.add(String(service.name));
    });
  return {
    parentId,
    startTree: tree.start,
    startTask: (service, transcriptPath) => tree.startTask(String(service.name), { transcriptPath }),
    completeTask: (service, summary) =>
      tree.completeTask(String(service.name), summary).pipe(Effect.zipRight(markSettled(service))),
    failTask: (service) =>
      tree
        .failTask(String(service.name), `Build ${String(service.name)} failed`, { exitCode: 1 })
        .pipe(Effect.zipRight(markSettled(service))),
    abortTask: (service, transcriptPath) =>
      tree
        .startTask(String(service.name), { transcriptPath })
        .pipe(
          Effect.zipRight(
            tree.failTask(String(service.name), `Build ${String(service.name)} aborted`, { exitCode: 1 }),
          ),
          Effect.zipRight(markSettled(service)),
        ),
    unsettledServices: () => services.filter((service) => !settled.has(String(service.name))),
    completeTree: tree.close(`${plan.name} built`),
    failTree: tree.close(`${plan.name} build failed`),
  };
};
