import { canonicalJson } from "@lando/sdk/digest";
import { LandofileValidationError } from "@lando/sdk/errors";
import {
  type EndpointPlan,
  PortablePath,
  type ServiceConfig,
  endpointInvariantIssues,
  logicalEndpointIdentity,
  validationIssue,
} from "@lando/sdk/schema";

/** Replay original declarations, never a previous normalization's synthesized facets. */
export const normalizeEndpoints = (
  contributions: readonly EndpointPlan[],
  config: ServiceConfig,
): EndpointPlan[] => {
  const endpoints: EndpointPlan[] =
    config.endpoints === undefined
      ? contributions.map((endpoint) => ({ ...endpoint }))
      : config.endpoints.map((endpoint) =>
          endpoint.protocol === "unix"
            ? { ...endpoint, socketPath: PortablePath.make(endpoint.socketPath) }
            : { ...endpoint },
        );

  if (config.endpoints === undefined) {
    for (const entry of config.ports ?? []) {
      const identity = `${entry.target}/${entry.protocol}`;
      const declarations = contributions.filter((endpoint) => logicalEndpointIdentity(endpoint) === identity);
      const protocols = [...new Set(declarations.map((endpoint) => endpoint.protocol))];
      const declaredProtocol = protocols.length === 1 ? protocols[0] : undefined;
      const protocol =
        declaredProtocol === "http" || declaredProtocol === "https" ? declaredProtocol : entry.protocol;
      const names = [
        ...new Set(declarations.flatMap((endpoint) => (endpoint.name === undefined ? [] : [endpoint.name]))),
      ];
      const hints = [
        ...new Set(
          declarations.flatMap((endpoint) =>
            endpoint.protocol === "unix" || endpoint.appProtocol === undefined ? [] : [endpoint.appProtocol],
          ),
        ),
      ];
      const name = entry.name ?? (names.length === 1 ? names[0] : undefined);
      const appProtocol = entry.appProtocol ?? (hints.length === 1 ? hints[0] : undefined);
      endpoints.push({
        _tag: "published",
        port: entry.target,
        protocol,
        ...(declarations.some((endpoint) => endpoint.protocol !== "unix" && endpoint.primary === true)
          ? { primary: true }
          : {}),
        ...(name === undefined ? {} : { name }),
        ...(appProtocol === undefined ? {} : { appProtocol }),
        publication: {
          ...(entry.hostIp === undefined ? {} : { bindAddress: entry.hostIp }),
          ...(entry.published === undefined ? {} : { hostPort: entry.published }),
        },
      });
    }
    for (const port of config.expose ?? []) {
      if (!endpoints.some((endpoint) => logicalEndpointIdentity(endpoint) === `${port}/tcp`)) {
        endpoints.push({ _tag: "internal", port, protocol: "tcp" });
      }
    }
  }

  const seen = new Set<string>();
  return endpoints.filter((endpoint) => {
    const key = canonicalJson(endpoint);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
};

export const endpointValidationError = (
  endpoints: readonly EndpointPlan[],
  location: { readonly appRoot: string; readonly serviceName: string },
): LandofileValidationError | undefined => {
  const issues = endpointInvariantIssues(endpoints);
  if (issues.length === 0) return undefined;
  const messages = issues.map((issue) => {
    switch (issue.kind) {
      case "alias-collision":
        return `Endpoint alias ${issue.name} belongs to different listeners: ${issue.identities.join(", ")}.`;
      case "protocol-conflict":
        return `Endpoint listener ${issue.identities.join(", ")} declares conflicting protocols.`;
      case "multiple-primary":
        return `Multiple primary endpoint listeners are declared: ${issue.identities.join(", ")}.`;
      default:
        return issue.kind satisfies never;
    }
  });
  return new LandofileValidationError({
    message: `Invalid endpoints for service ${location.serviceName}: ${messages.join(" ")}`,
    remediation:
      "Use aliases for only one logical listener, agree on its protocol, and mark at most one listener primary: true.",
    file: `${location.appRoot}/.lando.yml`,
    issues: messages.map((message) =>
      validationIssue(["services", location.serviceName, "endpoints"], message),
    ),
  });
};
