import { AppPlanSanitizer } from "@lando/sdk/services";
import { Layer } from "effect";
import { attachInvocationAuthority, invocationAuthorityForPlan } from "../../planner/invocation-authority.ts";

import { stripStartOverlays } from "../start-overlay-registry.ts";

export const layer = Layer.succeed(
  AppPlanSanitizer,
  AppPlanSanitizer.of({
    sanitizeForPersistence: (plan) => {
      const { events: _events, ...applied } = stripStartOverlays(plan);
      const authority = invocationAuthorityForPlan(applied);
      return authority === undefined
        ? applied
        : attachInvocationAuthority(applied, {
            sites: authority.sites.filter((site) => site.path[0] === "tooling"),
          });
    },
  }),
);
