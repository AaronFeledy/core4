import { ROUTE_PRIORITY_MAX } from "@lando/sdk/schema";
import { quoteYamlScalar } from "@lando/sdk/yaml";
import { Effect } from "effect";

import { dashboardConfigFile, dynamicConfigDir } from "./proxy-paths.ts";
import type { TraefikProxyDependencies } from "./proxy-types.ts";
import { normalizeDefaultDomain } from "./tls.ts";

// Router-owned hostnames cannot be captured by an app route.
export const TRAEFIK_DASHBOARD_PRIORITY = ROUTE_PRIORITY_MAX + 1;

export const renderTraefikDashboardConfig = (defaultDomain: string): string => {
  const rule = quoteYamlScalar(`Host(\`traefik.${normalizeDefaultDomain(defaultDomain)}\`)`);
  return [
    "http:",
    "  routers:",
    "    dashboard:",
    `      rule: ${rule}`,
    `      priority: ${TRAEFIK_DASHBOARD_PRIORITY}`,
    "      service: api@internal",
    "      entryPoints: [web]",
    "    dashboard-https:",
    `      rule: ${rule}`,
    `      priority: ${TRAEFIK_DASHBOARD_PRIORITY}`,
    "      service: api@internal",
    "      entryPoints: [websecure]",
    "      tls: {}",
    "",
  ].join("\n");
};

export const ensureDashboardFile = Effect.fn("TraefikRouter.ensureDashboardFile")(function* (
  dependencies: TraefikProxyDependencies,
  defaultDomain: string,
) {
  const file = dashboardConfigFile(dependencies.paths);
  const content = renderTraefikDashboardConfig(defaultDomain);
  if (yield* dependencies.fileSystem.exists(file)) {
    if ((yield* dependencies.fileSystem.readText(file)) === content) return;
  }
  yield* dependencies.fileSystem.mkdir(dynamicConfigDir(dependencies.paths));
  yield* dependencies.fileSystem.writeAtomic(file, content);
});
