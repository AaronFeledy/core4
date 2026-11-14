import type { AbsolutePath, AppPlan, ServicePlan } from "@lando/sdk/schema";
import { type ProgressEmitter, makeTaskTree } from "@lando/sdk/task-progress";
import { Effect } from "effect";

export interface BuildTaskProgress {
  readonly parentId: string;
  readonly startTree: Effect.Effect<void>;
  readonly startTask: (service: ServicePlan, transcriptPath?: AbsolutePath) => Effect.Effect<void>;
  readonly completeTask: (service: ServicePlan, summary: string) => Effect.Effect<void>;
  readonly failTask: (service: ServicePlan) => Effect.Effect<void>;
  readonly abortTask: (service: ServicePlan) => Effect.Effect<void>;
  readonly unsettledServices: () => ReadonlyArray<ServicePlan>;
  readonly abortedServices: () => ReadonlyArray<ServicePlan>;
  readonly completeTree: Effect.Effect<void>;
  readonly failTree: Effect.Effect<void>;
  readonly interruptTree: Effect.Effect<void>;
}

export const makeBuildTaskProgress = (events: ProgressEmitter, plan: AppPlan): BuildTaskProgress => {
  const services = Object.values(plan.services);
  const parentId = `build-artifact-${String(plan.id)}`;
  const settled = new Map<string, "complete" | "failed" | "aborted">();
  const tree = makeTaskTree(events, {
    parentId,
    label: `Building ${plan.name}`,
    children: services.map((service) => ({
      id: String(service.name),
      label: `Build ${String(service.name)}`,
    })),
    mode: "list",
  });
  const markSettled = (service: ServicePlan, outcome: "complete" | "failed" | "aborted") =>
    Effect.sync(() => {
      settled.set(String(service.name), outcome);
    });
  return {
    parentId,
    startTree: tree.start,
    startTask: (service, transcriptPath) =>
      tree.startTask(String(service.name), transcriptPath === undefined ? {} : { transcriptPath }),
    completeTask: (service, summary) =>
      tree.completeTask(String(service.name), summary).pipe(Effect.andThen(markSettled(service, "complete"))),
    failTask: (service) =>
      tree
        .startTask(String(service.name))
        .pipe(
          Effect.andThen(tree.failTask(String(service.name), `Build ${String(service.name)} failed`)),
          Effect.andThen(markSettled(service, "failed")),
        ),
    abortTask: (service) =>
      tree
        .startTask(String(service.name))
        .pipe(
          Effect.andThen(tree.failTask(String(service.name), `Build ${String(service.name)} aborted`)),
          Effect.andThen(markSettled(service, "aborted")),
        ),
    unsettledServices: () => services.filter((service) => !settled.has(String(service.name))),
    abortedServices: () => services.filter((service) => settled.get(String(service.name)) === "aborted"),
    completeTree: tree.close(`${plan.name} built`),
    failTree: tree.settleFailure(`${plan.name} build failed`),
    interruptTree: tree.settleInterrupt(`${plan.name} build interrupted`),
  };
};
