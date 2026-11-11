import { classifyLoweredEnvRedaction, planRedactionValues } from "@lando/redaction/plan-values";
import { RedactionService } from "@lando/redaction/service";
import type { AppPlan } from "@lando/sdk/schema";
import { Effect, Option } from "effect";

export const registerPlanRedaction = Effect.fnUntraced(function* (
  plan: AppPlan,
  environments: ReadonlyArray<Readonly<Record<string, string | undefined>> | undefined> = [],
) {
  const planValues = planRedactionValues(plan);
  const lowered = environments.map((env) =>
    classifyLoweredEnvRedaction(env, {
      wholeToken: planValues.wholeTokenValues,
      publicValues: planValues.publicValues,
    }),
  );
  const values = {
    substring: [...planValues.substring, ...lowered.flatMap((values) => values.substring)],
    wholeToken: [...planValues.wholeToken, ...lowered.flatMap((values) => values.wholeToken)],
    publicValues: planValues.publicValues,
  };
  const redaction = yield* Effect.serviceOption(RedactionService);
  if (Option.isSome(redaction)) {
    yield* redaction.value.registerValues(values.substring);
    yield* redaction.value.registerValues(values.wholeToken, { match: "whole-token" });
  }
  return values;
});
