import type { AppPlan } from "@lando/sdk/schema";

import { collectSecretEnvValues } from "@lando/redaction/service";

export const collectAppPlanRedactionTokens = (plan: Pick<AppPlan, "services">): ReadonlyArray<string> =>
  Object.values(plan.services).flatMap((service) => collectSecretEnvValues(service.environment));
