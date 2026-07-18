import { Either, Schema } from "effect";

import type { AppPlan, BuildStep, ServicePlan } from "@lando/sdk/schema";

import { appBuildKeyForStep } from "./build-key.ts";

const ProviderCommandSpec = Schema.Struct({
  command: Schema.Array(Schema.String),
  cwd: Schema.optional(Schema.String),
  env: Schema.optional(Schema.Record({ key: Schema.String, value: Schema.String })),
  stdin: Schema.optional(Schema.Literal("inherit", "ignore")),
  tty: Schema.optional(Schema.Boolean),
});

const AppBuildStepIntent = Schema.Struct({
  id: Schema.optional(Schema.String),
  phase: Schema.String,
  command: ProviderCommandSpec,
  dependsOn: Schema.optional(Schema.Array(Schema.String)),
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
    const decoded = Schema.decodeUnknownEither(AppBuildStepIntent)(entry);
    return Either.isRight(decoded) ? [decoded.right] : [];
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
      buildKey: appBuildKeyForStep({ command: intent.command, service, stepId: id }),
    },
  };
};

export const appStepBatches = (steps: ReadonlyArray<AppStep>): AppStepBatchPlan => {
  const internalIds = new Set(steps.map(({ step }) => step.id));
  const completed = new Set<string>();
  let pending = [...steps];
  const batches: Array<ReadonlyArray<AppStep>> = [];
  while (pending.length > 0) {
    const ready = pending.filter(({ step }) =>
      step.dependsOn.every((dependency) => !internalIds.has(dependency) || completed.has(dependency)),
    );
    if (ready.length === 0) {
      const pendingIds = new Set(pending.map(({ step }) => step.id));
      return {
        _tag: "Cycle",
        edges: pending.flatMap(({ step }) =>
          step.dependsOn
            .filter((dependency) => pendingIds.has(dependency))
            .map((dependency) => `${step.id} -> ${dependency}`),
        ),
      };
    }
    batches.push(ready);
    const readyIds = new Set(ready.map(({ step }) => step.id));
    for (const id of readyIds) completed.add(id);
    pending = pending.filter(({ step }) => !readyIds.has(step.id));
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
