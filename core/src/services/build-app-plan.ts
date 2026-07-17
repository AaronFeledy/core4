import { createHash } from "node:crypto";

import { Either, Schema } from "effect";

import type { AppPlan, BuildStep, ServicePlan } from "@lando/sdk/schema";

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

const appBuildIntents = (service: ServicePlan): ReadonlyArray<AppBuildStepIntent> => {
  const extension = service.extensions["@lando/core/service-features"];
  if (typeof extension !== "object" || extension === null || !("buildSteps" in extension)) return [];
  const decoded = Schema.decodeUnknownEither(Schema.Array(AppBuildStepIntent))(extension.buildSteps);
  return Either.isRight(decoded) ? decoded.right.filter((step) => step.phase === "app") : [];
};

const appBuildKey = (service: ServicePlan, intent: AppBuildStepIntent): string =>
  createHash("sha256")
    .update(JSON.stringify({ artifact: service.artifact, command: intent.command, service: service.name }))
    .digest("hex");

const stepFor = (service: ServicePlan, intent: AppBuildStepIntent, index: number): AppStep => ({
  command: intent.command,
  step: {
    id: `${String(service.name)}:app:${intent.id ?? index + 1}`,
    service: service.name,
    phase: "app",
    kind: "execStream",
    command: intent.command.command,
    dependsOn: [...(intent.dependsOn ?? [])],
    buildKey: appBuildKey(service, intent),
  },
});

export const appSteps = (plan: AppPlan): ReadonlyArray<AppStep> =>
  Object.values(plan.services).flatMap((service) =>
    appBuildIntents(service).map((intent, index) => stepFor(service, intent, index)),
  );

export const providerCommand = (command: AppStep["command"]) => ({
  command: command.command,
  ...(command.cwd === undefined ? {} : { cwd: command.cwd }),
  ...(command.env === undefined ? {} : { env: command.env }),
  ...(command.stdin === undefined ? {} : { stdin: command.stdin }),
  ...(command.tty === undefined ? {} : { tty: command.tty }),
});
