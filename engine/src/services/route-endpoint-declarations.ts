import type { NormalizedRoute } from "@lando/landofile/route-normalize";
import type { EndpointPlan, ValidationIssue } from "@lando/sdk/schema";

type Protocol = Exclude<EndpointPlan["protocol"], "unix">;

export const routeEndpointDeclarations = (input: {
  readonly service: string;
  readonly routes: readonly NormalizedRoute[];
  readonly effective: readonly EndpointPlan[];
  readonly replaced: readonly EndpointPlan[];
  readonly allowImplication: boolean;
}) => {
  const implied: EndpointPlan[] = [];
  const conflicts = new Map<NormalizedRoute, ValidationIssue>();
  const bySource = new Map<string, ValidationIssue>();
  const index = () => {
    const ports = new Map<number, Set<Protocol>>();
    const add = (endpoint: EndpointPlan, replaced: boolean) => {
      const { protocol } = endpoint;
      if (protocol === "unix" || (replaced && (protocol === "http" || protocol === "https"))) return;
      const existing = ports.get(endpoint.port);
      if (existing === undefined) ports.set(endpoint.port, new Set([protocol]));
      else existing.add(protocol);
    };
    for (const endpoint of input.effective) add(endpoint, false);
    for (const endpoint of input.replaced) add(endpoint, true);
    return ports;
  };
  let ports: ReturnType<typeof index> | undefined;
  for (const route of input.routes) {
    const { endpoint: port, source } = route;
    if (typeof port !== "number") continue;
    ports ??= index();
    const declared = ports.get(port);
    if (declared === undefined) {
      if (!input.allowImplication) continue;
      implied.push({ kind: "internal", protocol: "http", port });
      ports.set(port, new Set(["http"]));
    } else if (!declared.has("http") && !declared.has("https")) {
      const path = source?.path ?? ["services", input.service, "routes"];
      const provenance = source?.provenance;
      // Merge can split one authored `both` route across two effective indexes.
      const key = source === undefined ? undefined : JSON.stringify(provenance ?? [source.file, path]);
      const issue = (key === undefined ? undefined : bySource.get(key)) ?? {
        path,
        reason: "route-endpoint-protocol-conflict",
        message: `Route for service ${input.service} selects port ${port}, which declares ${[...declared].join(" and ")}, not HTTP.`,
        suggestion: `Select the actual HTTP or HTTPS port, or declare http:${port} or https:${port} if that is what the service runs.`,
        ...(provenance === undefined ? {} : { source: provenance }),
      };
      if (key !== undefined) bySource.set(key, issue);
      conflicts.set(route, issue);
    }
  }
  return { implied, conflicts };
};
