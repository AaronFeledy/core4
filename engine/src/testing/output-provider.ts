import { RedactionService } from "@lando/redaction/service";
import type { AppPlan } from "@lando/sdk/schema";
import type { RuntimeProviderShape } from "@lando/sdk/services";
import { Effect } from "effect";
import { withOutputRegistration } from "../providers/output-policy.ts";
import { registerProviderOutput } from "../providers/output-redaction.ts";

export const outputRegisteredTestProvider = (
  provider: RuntimeProviderShape,
  plan?: AppPlan,
): RuntimeProviderShape =>
  withOutputRegistration(provider, (target) =>
    registerProviderOutput({
      provider,
      target: target.plan === undefined && plan?.id === target.app ? { ...target, plan } : target,
      appliedPlans: plan === undefined ? [] : [plan],
    }).pipe(Effect.provide(RedactionService.layer)),
  );
