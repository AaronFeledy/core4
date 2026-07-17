import { type Context, DateTime } from "effect";

import type { AppPlan, ServicePlan } from "@lando/sdk/schema";
import type { Redactor } from "@lando/sdk/secrets";
import type { EventService } from "@lando/sdk/services";

export interface ArtifactBuildStep {
  readonly phase: "artifact";
  readonly service: ServicePlan;
  readonly buildKey: string;
}

export interface RedactedBuildContext {
  readonly appRef: {
    readonly kind: "scratch" | "user";
    readonly id: string;
  };
  readonly appRoot: string;
  readonly serviceName: string;
  readonly providerId: string;
}

const timestamp = () => DateTime.unsafeMake(new Date().toISOString());

export const redactedBuildContext = (
  redactor: Pick<Redactor, "redactString">,
  plan: AppPlan,
  service: ServicePlan,
): RedactedBuildContext => {
  return {
    appRef: {
      kind: String(plan.id).startsWith("scratch-") ? "scratch" : "user",
      id: redactor.redactString(plan.slug),
    },
    appRoot: redactor.redactString(plan.root),
    serviceName: redactor.redactString(service.name),
    providerId: redactor.redactString(plan.provider),
  };
};

export const publishArtifactBuildStepSkip = (
  events: Context.Tag.Service<typeof EventService>,
  context: RedactedBuildContext,
  step: ArtifactBuildStep,
  reason: "up-to-date" | "phase-aborted" = "up-to-date",
) =>
  events.publish({
    _tag: "build-step-skip",
    eventName: "build-step-skip",
    appRef: context.appRef,
    serviceName: context.serviceName,
    providerId: context.providerId,
    phase: step.phase,
    buildKey: step.buildKey,
    cached: reason === "up-to-date",
    reason,
    timestamp: timestamp(),
  });
