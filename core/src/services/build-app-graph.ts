import { gateNodeId } from "@lando/container-runtime/dependency-gates";
import type { ScheduleEdge, ScheduleGraph, ScheduleNode } from "@lando/container-runtime/dependency-schedule";

import type { AppPlan, ServiceDependencyCondition, ServiceName } from "@lando/sdk/schema";

import { type AppStep, appStepBatches } from "./build-app-plan.ts";

/**
 * Internal app-build DAG vocabulary.
 *
 * A `step` node is a real build step the user sees in the task tree. A `gate`
 * node is the synthetic predecessor a `depends_on` condition resolves to
 * (`<svc>:running` / `<svc>:healthy` / `<svc>:completed`). Gates are runner-internal:
 * they never reach the task tree, the step counts, or any build-step event.
 */
export type AppNode =
  | { readonly _tag: "step"; readonly appStep: AppStep }
  | {
      readonly _tag: "gate";
      readonly service: ServiceName;
      readonly condition: ServiceDependencyCondition;
    };

export type AppBuildGraphPlan =
  | { readonly _tag: "Cycle"; readonly edges: ReadonlyArray<string> }
  | { readonly _tag: "Graph"; readonly graph: ScheduleGraph<AppNode> };

export const appStepNodeId = (id: string): string => `step:${id}`;

/**
 * Builds the app-build graph, or reports a step cycle before anything runs.
 *
 * Cycle detection stays pre-flight and step-scoped: a gate has no predecessors
 * inside this graph, so it cannot participate in a cycle, which keeps the
 * step-only check complete.
 */
export const buildAppGraph = (plan: AppPlan, steps: ReadonlyArray<AppStep>): AppBuildGraphPlan => {
  const batchPlan = appStepBatches(steps);
  if (batchPlan._tag === "Cycle") return { _tag: "Cycle", edges: batchPlan.edges };

  const stepIds = new Set(steps.map(({ step }) => step.id));
  const nodes: Array<ScheduleNode<AppNode>> = steps.map((appStep) => ({
    id: appStepNodeId(appStep.step.id),
    value: { _tag: "step", appStep },
  }));
  const edges: Array<ScheduleEdge> = [];

  for (const { step } of steps) {
    for (const dependency of step.dependsOn) {
      if (!stepIds.has(dependency)) continue;
      edges.push({
        predecessor: appStepNodeId(dependency),
        dependent: appStepNodeId(step.id),
        required: true,
      });
    }
  }

  const servicesByName = new Map(
    Object.values(plan.services).map((service) => [String(service.name), service]),
  );
  const gates = new Map<string, AppNode>();
  const stepsByService = new Map<string, Array<string>>();
  for (const { step } of steps) {
    const key = String(step.service);
    const existing = stepsByService.get(key);
    if (existing === undefined) stepsByService.set(key, [appStepNodeId(step.id)]);
    else existing.push(appStepNodeId(step.id));
  }

  for (const [serviceName, dependentStepIds] of stepsByService) {
    const service = servicesByName.get(serviceName);
    if (service === undefined) continue;
    for (const dependency of service.dependsOn) {
      const targetName = String(dependency.service);
      if (!servicesByName.has(targetName)) continue;
      const id = gateNodeId(targetName, dependency.condition);
      if (!gates.has(id)) {
        gates.set(id, { _tag: "gate", service: dependency.service, condition: dependency.condition });
      }
      for (const dependentStepId of dependentStepIds) {
        edges.push({ predecessor: id, dependent: dependentStepId, required: dependency.required });
      }
    }
  }

  for (const [id, value] of gates) nodes.push({ id, value });

  return { _tag: "Graph", graph: { nodes, edges } };
};
