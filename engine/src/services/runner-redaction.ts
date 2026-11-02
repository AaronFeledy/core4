import { classifyLoweredEnvRedaction } from "@lando/redaction/plan-values";
import { collectSecretEnvValues } from "@lando/redaction/service";
import { Effect } from "effect";
import type { CapturedHostExecutionContext } from "./host-execution-context.ts";
import { environmentForRedaction } from "./tooling-input-environment.ts";

export type RunnerRedactionCarrier = {
  readonly substring: readonly string[];
  readonly wholeToken?: ReadonlySet<string>;
  readonly publicValues?: ReadonlySet<string>;
};

export const runnerEnvRedaction = Effect.fnUntraced(function* (
  carrier: RunnerRedactionCarrier,
  context: CapturedHostExecutionContext,
) {
  const merged = yield* environmentForRedaction(context.env, context.explicitEnv);
  const hostEnv: Record<string, string | undefined> = {};
  const callerEnv: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(merged)) {
    if (Object.hasOwn(context.explicitEnv, key)) callerEnv[key] = value;
    else hostEnv[key] = value;
  }
  const classified = classifyLoweredEnvRedaction(callerEnv, carrier);
  return {
    substring: [...collectSecretEnvValues(hostEnv), ...classified.substring],
    wholeToken: classified.wholeToken,
  };
});
