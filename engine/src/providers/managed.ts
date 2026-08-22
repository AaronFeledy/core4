import { DateTime } from "effect";

import { AbsolutePath, AppId, type AppPlan, type ProviderId } from "@lando/sdk/schema";

import { CAPABILITY_DEFAULT_PROVIDER_ID } from "./precedence.ts";

/**
 * The Lando-managed runtime provider. The host-level global app (Traefik,
 * ssh-agent, Mailpit) always uses this provider — leftover
 * `defaultProviderId: docker` in user config must not take over.
 */
export const MANAGED_PROVIDER_ID: ProviderId = CAPABILITY_DEFAULT_PROVIDER_ID;

/** Plan used only to select the Lando-managed provider. */
export const MANAGED_PROVIDER_SELECT_PLAN: AppPlan = {
  id: AppId.make("global"),
  name: "global",
  slug: "global",
  root: AbsolutePath.make("/"),
  provider: MANAGED_PROVIDER_ID,
  services: {},
  routes: [],
  networks: [],
  stores: [],
  fileSync: [],
  metadata: {
    resolvedAt: DateTime.unsafeMake("1970-01-01T00:00:00.000Z"),
    source: "global-app",
    runtime: 4,
  },
  extensions: {},
};

export const taggedErrorRemediation = (cause: unknown): string | undefined => {
  if (cause === null || typeof cause !== "object") return undefined;
  const remediation = Reflect.get(cause, "remediation");
  return typeof remediation === "string" && remediation.length > 0 ? remediation : undefined;
};
