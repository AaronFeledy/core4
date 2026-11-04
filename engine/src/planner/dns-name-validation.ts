import { type LandofileShape, type ValidationIssuePath, landoServiceContainerName } from "@lando/sdk/schema";
import type { PlannerIssue } from "./resolved-validation.ts";

/**
 * Every DNS name a service answers to must be its own: service keys, `hostnames:`, network aliases,
 * and the derived `<service>.<slug>.internal` and container names share one namespace per network,
 * compared case-insensitively.
 */
export const dnsNameIssues = (input: {
  readonly landofile: LandofileShape;
  readonly isBlocked: (path: ValidationIssuePath) => boolean;
  readonly appSlug: string | undefined;
}): ReadonlyArray<PlannerIssue> => {
  const { landofile, isBlocked } = input;
  const issues: PlannerIssue[] = [];
  const dnsNamespaces = new Map<string, Map<string, string>>();
  const dnsCollisionSites = new Set<string>();
  const containerNames = new Map<string, string>();
  for (const [name, service] of Object.entries(landofile.services ?? {})) {
    // Service keys and the names derived from them are concrete even when a field inside the service is blocked.
    const claim = (network: string, dnsName: string, path: ValidationIssuePath, concrete = false) => {
      if (!concrete && isBlocked(path)) return;
      if (network !== "default" && !Object.hasOwn(landofile.networks ?? {}, network)) return;
      const names = dnsNamespaces.get(network) ?? new Map<string, string>();
      dnsNamespaces.set(network, names);
      const other = names.get(dnsName.toLowerCase());
      if (other !== undefined && other !== name) {
        const site = JSON.stringify([network, path]);
        if (dnsCollisionSites.has(site)) return;
        dnsCollisionSites.add(site);
        issues.push({
          path,
          rule: "landofile.dns-name",
          message: `DNS name ${dnsName} is already claimed by service ${other} on network ${network}.`,
          suggestion:
            "Rename one of the services or its DNS aliases so each name identifies one service on this network.",
        });
      } else names.set(dnsName.toLowerCase(), name);
    };
    const authoredClaim = (network: string, dnsName: string, path: ValidationIssuePath, concrete = false) => {
      if (!concrete && isBlocked(path)) return;
      if (!dnsName.includes(".") && /^lando-.*--/iu.test(dnsName)) {
        issues.push({
          path,
          rule: "landofile.dns-name",
          message: `DNS name ${dnsName} uses the lando-<app>--<service> shape reserved for Lando's container names.`,
          suggestion:
            "Rename this service or DNS alias to a name that does not start with lando- and contain --.",
        });
      }
      claim(network, dnsName, path, concrete);
    };
    const servicePath = ["services", name];
    authoredClaim("default", name, servicePath, true);
    if (input.appSlug !== undefined) {
      claim("default", `${name}.${input.appSlug}.internal`, servicePath, true);
      const containerName = landoServiceContainerName(input.appSlug, name);
      const other = containerNames.get(containerName);
      if (other === undefined) containerNames.set(containerName, name);
      else
        issues.push({
          path: servicePath,
          rule: "landofile.dns-name",
          message: `Services ${other} and ${name} would share the container name ${containerName}.`,
          suggestion: "Rename one of the services.",
        });
    }
    for (const [index, hostname] of (service.hostnames ?? []).entries())
      authoredClaim("default", hostname, [...servicePath, "hostnames", index]);
    for (const [network, attachment] of Object.entries(service.networks ?? {})) {
      const path = [...servicePath, "networks", network];
      if (network !== "default" && input.appSlug !== undefined)
        claim(network, `${name}.${input.appSlug}.internal`, path, true);
      for (const [index, alias] of (attachment.aliases ?? []).entries())
        authoredClaim(network, alias, [...path, "aliases", index]);
    }
  }
  return issues;
};
