import { collectProxyUrls } from "@lando/redaction/plan-values";
import {
  RedactionService,
  collectUrlCredentialValues,
  createPayloadValues,
  createStandaloneRedactor,
} from "@lando/redaction/service";
import type { AppPlan } from "@lando/sdk/schema";
import {
  type Redactor,
  type TieredRedactionValues,
  isPublicDefaultCredential,
  isUsableExactRedactionValue,
} from "@lando/sdk/secrets";
import { Effect, Option } from "effect";

import { appSteps } from "./build-app-plan.ts";
import { registerPlanRedaction } from "./plan-redaction.ts";

export interface BuildRedaction {
  readonly redactor: Redactor;
  /** Live value getter, so registrations made after the build starts still apply. */
  readonly payloadValues: () => TieredRedactionValues;
}

export const registerBuildRedaction = Effect.fnUntraced(function* (
  plan: AppPlan,
): Effect.fn.Return<BuildRedaction> {
  const extraEnvironments: ReadonlyArray<Readonly<Record<string, string | undefined>>> = [
    ...Object.values(plan.services).flatMap((service) =>
      service.artifact?.kind === "build" && service.artifact.args !== undefined
        ? [service.artifact.args]
        : [],
    ),
    ...appSteps(plan).flatMap(({ command }) => (command.env === undefined ? [] : [command.env])),
  ];
  const values = yield* registerPlanRedaction(plan, extraEnvironments);
  const proxyUrls = collectProxyUrls(process.env);
  const options = {
    sourceEnv: process.env,
    redactionTokens: values.substring,
    wholeTokenValues: values.wholeToken,
    proxyUrls,
  };
  const redaction = yield* Effect.serviceOption(RedactionService);
  if (Option.isSome(redaction)) {
    // The registry's own error redaction reads registered values, not this profile's options.
    // Reject unusable values so registering a proxy credential cannot blank every string.
    yield* redaction.value.registerValues(
      collectUrlCredentialValues(proxyUrls).filter(
        (value) => isUsableExactRedactionValue(value) && !isPublicDefaultCredential(value),
      ),
    );
    return {
      redactor: yield* redaction.value.forProfile("secrets", options),
      payloadValues: yield* redaction.value.payloadValues(options),
    };
  }
  return {
    redactor: createStandaloneRedactor("secrets", options),
    payloadValues: createPayloadValues([], options),
  };
});
