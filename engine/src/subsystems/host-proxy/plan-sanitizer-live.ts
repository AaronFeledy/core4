import { Layer } from "effect";

import { AppPlanSanitizer } from "@lando/sdk/services";
import { attachInvocationAuthority, invocationAuthorityForPlan } from "../../planner/invocation-authority.ts";

import { stripDebuggerHost } from "../debugger-host.ts";
import { stripGpgAgentOverlay } from "../gpg-agent/overlay.ts";
import { stripSshAgentOverlay } from "../ssh-agent/overlay.ts";
import { stripHostProxyRunLando } from "./transport-feature.ts";

export const layer = Layer.succeed(
  AppPlanSanitizer,
  AppPlanSanitizer.of({
    sanitizeForPersistence: (plan) => {
      const { events: _events, ...applied } = stripDebuggerHost(
        stripGpgAgentOverlay(stripSshAgentOverlay(stripHostProxyRunLando(plan))),
      );
      const authority = invocationAuthorityForPlan(applied);
      return authority === undefined
        ? applied
        : attachInvocationAuthority(applied, {
            sites: authority.sites.filter((site) => site.path[0] === "tooling"),
          });
    },
  }),
);
