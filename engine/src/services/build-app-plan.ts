import { Graph, Result, Schema } from "effect";

import type { AppPlan, BuildStep, ServicePlan } from "@lando/sdk/schema";

import { appBuildKeyForStep } from "./build-key.ts";

const ProviderCommandSpec = Schema.Struct({
  command: Schema.Array(Schema.String),
  cwd: Schema.optionalKey(Schema.String),
  env: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
  stdin: Schema.optionalKey(Schema.Literals(["inherit", "ignore"])),
  tty: Schema.optionalKey(Schema.Boolean),
});

const AppBuildStepIntent = Schema.Struct({
  id: Schema.optionalKey(Schema.String),
  phase: Schema.String,
  command: ProviderCommandSpec,
  dependsOn: Schema.optionalKey(Schema.Array(Schema.String)),
  user: Schema.optionalKey(Schema.String),
});
type AppBuildStepIntent = typeof AppBuildStepIntent.Type;

export interface AppStep {
  readonly command: AppBuildStepIntent["command"];
  readonly step: BuildStep;
}

export type AppStepBatchPlan =
  | { readonly _tag: "Batches"; readonly batches: ReadonlyArray<ReadonlyArray<AppStep>> }
  | { readonly _tag: "Cycle"; readonly edges: ReadonlyArray<string> };

const appBuildIntents = (service: ServicePlan): ReadonlyArray<AppBuildStepIntent> => {
  const extension = service.extensions["@lando/core/service-features"];
  if (typeof extension !== "object" || extension === null || !("buildSteps" in extension)) return [];
  if (!Array.isArray(extension.buildSteps)) return [];
  return extension.buildSteps.flatMap((entry) => {
    if (typeof entry !== "object" || entry === null || !("phase" in entry) || entry.phase !== "app") {
      return [];
    }
    const decoded = Schema.decodeUnknownResult(AppBuildStepIntent)(entry);
    return Result.isSuccess(decoded) ? [decoded.success] : [];
  });
};

const stepIdFor = (service: ServicePlan, intent: AppBuildStepIntent, index: number): string =>
  `${String(service.name)}:app:${intent.id ?? index + 1}`;

const stepFor = (
  service: ServicePlan,
  intent: AppBuildStepIntent,
  intents: ReadonlyArray<AppBuildStepIntent>,
  index: number,
): AppStep => {
  const id = stepIdFor(service, intent, index);
  const previous = index === 0 ? undefined : intents[index - 1];
  const dependencies = [
    ...(intent.dependsOn ?? []).map((dependency) => {
      const localIndex = intents.findIndex((candidate) => candidate.id === dependency);
      const local = localIndex < 0 ? undefined : intents[localIndex];
      return local === undefined ? dependency : stepIdFor(service, local, localIndex);
    }),
    ...(previous === undefined ? [] : [stepIdFor(service, previous, index - 1)]),
  ];
  return {
    command: intent.command,
    step: {
      id,
      service: service.name,
      phase: "app",
      kind: "execStream",
      command: intent.command.command,
      dependsOn: [...new Set(dependencies)],
      ...(intent.user === undefined ? {} : { user: intent.user }),
      buildKey: appBuildKeyForStep({
        command: intent.command,
        service,
        stepId: id,
        ...(intent.user === undefined ? {} : { user: intent.user }),
      }),
    },
  };
};

export const appStepBatches = (steps: ReadonlyArray<AppStep>): AppStepBatchPlan => {
  const indices = new Map<string, Graph.NodeIndex>();
  const pending = Graph.beginMutation(
    Graph.directed<AppStep, string>((mutable) => {
      for (const entry of steps) indices.set(entry.step.id, Graph.addNode(mutable, entry));
      for (const { step } of steps) {
        const dependent = indices.get(step.id);
        if (dependent === undefined) continue;
        for (const dependency of step.dependsOn) {
          const predecessor = indices.get(dependency);
          if (predecessor !== undefined) {
            Graph.addEdge(mutable, predecessor, dependent, `${step.id} -> ${dependency}`);
          }
        }
      }
    }),
  );
  const batches: Array<ReadonlyArray<AppStep>> = [];
  while (Graph.nodeCount(pending) > 0) {
    const ready = [...Graph.entries(Graph.nodes(pending))].filter(
      ([index]) => Graph.inDegree(pending, index) === 0,
    );
    if (ready.length === 0) {
      return {
        _tag: "Cycle",
        edges: [...Graph.values(Graph.edges(pending))].map((edge) => edge.data),
      };
    }
    batches.push(ready.map(([, entry]) => entry));
    for (const [index] of ready) Graph.removeNode(pending, index);
  }
  return { _tag: "Batches", batches };
};

export const appSteps = (plan: AppPlan): ReadonlyArray<AppStep> =>
  Object.values(plan.services).flatMap((service) => {
    const intents = appBuildIntents(service);
    return intents.map((intent, index) => stepFor(service, intent, intents, index));
  });

export const providerCommand = (command: AppStep["command"]) => ({
  command: command.command,
  ...(command.cwd === undefined ? {} : { cwd: command.cwd }),
  ...(command.env === undefined ? {} : { env: command.env }),
  ...(command.stdin === undefined ? {} : { stdin: command.stdin }),
  ...(command.tty === undefined ? {} : { tty: command.tty }),
});
