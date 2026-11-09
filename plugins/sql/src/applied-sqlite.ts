import { PlanReplanRequiredError } from "@lando/sdk/errors";
import { canonicalSqlitePath } from "@lando/sdk/schema";
import { Effect } from "effect";
import type { SqlCommandDeps } from "./command-types.ts";

export const requireAppliedSqliteTargets = (
  deps: Pick<SqlCommandDeps, "landofile" | "plan" | "providerId">,
  selected?: string,
) => {
  for (const [name, service] of Object.entries(deps.landofile.services ?? {})) {
    if (selected !== undefined && name !== selected) continue;
    const authored = service?.sqlite;
    if (authored === undefined) continue;
    if (canonicalSqlitePath(authored.path) !== deps.plan.services[name]?.sqlite?.path) {
      return Effect.fail(
        new PlanReplanRequiredError({
          app: deps.plan.id,
          providerId: deps.providerId,
          operation: "SQLite target",
          message: `The SQLite target for ${name} has not been applied.`,
          remediation: "Run `lando start` to apply the SQLite target, then retry.",
        }),
      );
    }
  }
  return Effect.void;
};
