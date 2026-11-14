import {
  type LandofileShape,
  type ServiceConfig,
  type ValidationIssuePath,
  landoServiceContainerName,
} from "@lando/sdk/schema";
import type { PlannerIssue } from "./resolved-validation.ts";

export interface DnsNameClaim {
  readonly network: string;
  readonly name: string;
  readonly service: string;
  readonly path: ValidationIssuePath;
  /** Service keys and derived names are concrete even when a field inside the service is blocked. */
  readonly concrete: boolean;
  /** True when the name is authored, so the reserved `lando-<app>--<service>` shape applies. */
  readonly authored: boolean;
}

/**
 * Every DNS name a service claims: its key, any `hostnames:`, network aliases,
 * and the derived `<service>.<slug>.internal` names.
 */
export const dnsNameClaims = (input: {
  readonly services: Readonly<Record<string, ServiceConfig>> | undefined;
  readonly appSlug?: string | undefined;
}): ReadonlyArray<DnsNameClaim> => {
  const claims: DnsNameClaim[] = [];
  for (const [name, service] of Object.entries(input.services ?? {})) {
    const servicePath: ValidationIssuePath = ["services", name];
    claims.push({
      network: "default",
      name,
      service: name,
      path: servicePath,
      concrete: true,
      authored: true,
    });
    if (input.appSlug !== undefined)
      claims.push({
        network: "default",
        name: `${name}.${input.appSlug}.internal`,
        service: name,
        path: servicePath,
        concrete: true,
        authored: false,
      });
    for (const [index, hostname] of (service.hostnames ?? []).entries())
      claims.push({
        network: "default",
        name: hostname,
        service: name,
        path: [...servicePath, "hostnames", index],
        concrete: false,
        authored: true,
      });
    for (const [network, attachment] of Object.entries(service.networks ?? {})) {
      const path: ValidationIssuePath = [...servicePath, "networks", network];
      if (network !== "default" && input.appSlug !== undefined)
        claims.push({
          network,
          name: `${name}.${input.appSlug}.internal`,
          service: name,
          path,
          concrete: true,
          authored: false,
        });
      for (const [index, alias] of (attachment.aliases ?? []).entries())
        claims.push({
          network,
          name: alias,
          service: name,
          path: [...path, "aliases", index],
          concrete: false,
          authored: true,
        });
    }
  }
  return claims;
};

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
  for (const claim of dnsNameClaims({ services: landofile.services, appSlug: input.appSlug })) {
    if (!claim.concrete && isBlocked(claim.path)) continue;
    if (claim.authored && !claim.name.includes(".") && /^lando-.*--/iu.test(claim.name)) {
      issues.push({
        path: claim.path,
        rule: "landofile.dns-name",
        message: `DNS name ${claim.name} uses the lando-<app>--<service> shape reserved for Lando's container names.`,
        suggestion:
          "Rename this service or DNS alias to a name that does not start with lando- and contain --.",
      });
    }
    if (claim.network !== "default" && !Object.hasOwn(landofile.networks ?? {}, claim.network)) continue;
    const names = dnsNamespaces.get(claim.network) ?? new Map<string, string>();
    dnsNamespaces.set(claim.network, names);
    const other = names.get(claim.name.toLowerCase());
    if (other !== undefined && other !== claim.service) {
      const site = JSON.stringify([claim.network, claim.path]);
      if (!dnsCollisionSites.has(site)) {
        dnsCollisionSites.add(site);
        issues.push({
          path: claim.path,
          rule: "landofile.dns-name",
          message: `DNS name ${claim.name} is already claimed by service ${other} on network ${claim.network}.`,
          suggestion:
            "Rename one of the services or its DNS aliases so each name identifies one service on this network.",
        });
      }
    } else names.set(claim.name.toLowerCase(), claim.service);
  }
  if (input.appSlug !== undefined) {
    for (const [name] of Object.entries(landofile.services ?? {})) {
      const containerName = landoServiceContainerName(input.appSlug, name);
      const other = containerNames.get(containerName);
      if (other === undefined) containerNames.set(containerName, name);
      else
        issues.push({
          path: ["services", name],
          rule: "landofile.dns-name",
          message: `Services ${other} and ${name} would share the container name ${containerName}.`,
          suggestion: "Rename one of the services.",
        });
    }
  }
  return issues;
};
