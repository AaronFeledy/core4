import { type NormalizedRoute, normalizeRoute } from "@lando/landofile/route-normalize";
import { getLandofileValueSource } from "@lando/landofile/validation";
import {
  DomainName,
  LANDO_SHARED_CROSS_APP_NETWORK,
  type LandofileShape,
  type RouteInput,
  ServiceName,
  type ValidationIssue,
  type ValidationIssuePath,
  authoredProbeTargetError,
  landoAuthoredNetworkName,
} from "@lando/sdk/schema";
import { Iterable, Result, Schema } from "effect";
import { deferredSiteKey } from "./landofile-scopes.ts";
import { appNetworkName } from "./naming.ts";

export type PlannerIssue = ValidationIssue & { readonly rule: string };

export const attributePlannerIssue = (landofile: LandofileShape, issue: PlannerIssue): PlannerIssue => {
  const source = getLandofileValueSource(landofile, issue.path);
  return { ...issue, ...(source === undefined ? {} : { source }) };
};

/** Validate authored fields only after every available planner scope has materialized. */
export const validateResolvedLandofile = (input: {
  readonly landofile: LandofileShape;
  readonly landofilePath: string;
  readonly blocked: ReadonlySet<string>;
  readonly appSlug?: string;
}) => {
  const { landofile, blocked } = input;
  const issues: PlannerIssue[] = [];
  const networkIssue = (path: ValidationIssuePath, message: string, suggestion: string) => {
    if (!isBlocked(path)) issues.push({ path, rule: "landofile.network", message, suggestion });
  };
  const routes = new Map<string, ReadonlyArray<NormalizedRoute> | undefined>();
  const isBlocked = (path: ValidationIssuePath) => {
    const key = deferredSiteKey(path);
    // Keys are JSON arrays, so a descendant site repeats this key's elements followed by a comma.
    const descendant = `${key.slice(0, -1)},`;
    return Iterable.some(blocked, (site) => path.length === 0 || site === key || site.startsWith(descendant));
  };
  const checkRoutes = (entries: readonly RouteInput[] | undefined, prefix: ValidationIssuePath) => {
    const normalized: NormalizedRoute[] = [];
    for (const [index, entry] of (entries ?? []).entries()) {
      const path = [...prefix, index];
      const source = getLandofileValueSource(landofile, path);
      const result = normalizeRoute(entry, {
        path,
        file: source?.file ?? input.landofilePath,
        ...(source === undefined ? {} : { provenance: source }),
      });
      // A blocked value still holds expression text; report only the fields that were evaluated.
      if (Result.isFailure(result)) {
        for (const issue of result.failure)
          if (!isBlocked(issue.path)) issues.push({ ...issue, rule: "landofile.route" });
      } else if (!isBlocked(path)) normalized.push(result.success);
    }
    return normalized;
  };
  const bridgeName = input.appSlug === undefined ? undefined : appNetworkName(input.appSlug);
  for (const [key, network] of Object.entries(landofile.networks ?? {})) {
    const path = ["networks", key];
    if (key === "default")
      networkIssue(
        path,
        "Lando owns the default app network.",
        "Declare a separately keyed network and list it on the services that should join it.",
      );
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/u.test(key))
      networkIssue(
        path,
        `Invalid network key ${JSON.stringify(key)}.`,
        "Start network keys with a letter or digit and use only letters, digits, underscores, dots, and hyphens.",
      );
    if (network.external === true && network.driver !== undefined)
      networkIssue(
        [...path, "driver"],
        "External networks cannot declare a driver.",
        "Remove driver; the existing network owns its driver configuration.",
      );
    if (network.external !== true && network.name !== undefined)
      networkIssue(
        [...path, "name"],
        "App-owned networks cannot declare a physical name.",
        "Lando names the networks it creates. To join a network that already exists, set external: true.",
      );
    const name = network.name ?? key;
    if (
      network.external === true &&
      input.appSlug !== undefined &&
      name.startsWith(landoAuthoredNetworkName(input.appSlug, ""))
    )
      networkIssue(
        path,
        `External network ${name} uses a name Lando generates for this app's own networks.`,
        "Remove external and name to let Lando manage this network, or join a network another project owns by its own name.",
      );
    if (network.external === true && (name === bridgeName || name === LANDO_SHARED_CROSS_APP_NETWORK))
      networkIssue(
        path,
        `External network ${name} is already a Lando app or shared network.`,
        "Remove this declaration; services already join Lando's app and shared networks.",
      );
  }
  const joined = new Set(
    Object.values(landofile.services ?? {}).flatMap((service) => Object.keys(service.networks ?? {})),
  );
  const physicalNames = new Map<string, string>();
  for (const [key, network] of Object.entries(landofile.networks ?? {})) {
    if (!joined.has(key) || input.appSlug === undefined) continue;
    const name =
      network.external === true ? (network.name ?? key) : landoAuthoredNetworkName(input.appSlug, key);
    const other = physicalNames.get(name);
    if (other !== undefined)
      networkIssue(
        ["networks", key],
        `Networks ${other} and ${key} both resolve to network ${name}.`,
        "Give each external network its own name, or join one network entry from every service that needs it.",
      );
    else physicalNames.set(name, key);
  }
  for (const [name, service] of Object.entries(landofile.services ?? {})) {
    for (const key of Object.keys(service.networks ?? {})) {
      if (key !== "default" && !Object.hasOwn(landofile.networks ?? {}, key))
        networkIssue(
          ["services", name, "networks", key],
          `Service ${name} joins undeclared network ${key}.`,
          `Declare ${key} under top-level networks:, or remove the service attachment.`,
        );
    }
    const proxy = landofile.proxy?.[ServiceName.make(name)];
    const serviceRoutes = checkRoutes(service.routes, ["services", name, "routes"]);
    const proxyRoutes = checkRoutes(proxy, ["proxy", name]);
    routes.set(
      name,
      service.routes === undefined && proxy === undefined ? undefined : [...serviceRoutes, ...proxyRoutes],
    );
    for (const [index, hostname] of (service.hostnames ?? []).entries()) {
      const path = ["services", name, "hostnames", index];
      if (isBlocked(path)) continue;
      if (Result.isFailure(Schema.decodeUnknownResult(DomainName)(hostname))) {
        issues.push({
          path,
          rule: "landofile.hostname",
          message: `Invalid hostname ${JSON.stringify(hostname)}.`,
          suggestion:
            "Use a DNS hostname with letters, digits, and hyphens in each label, such as app.lndo.site; do not include a scheme, port, path, or wildcard.",
        });
      }
    }
    for (const role of ["healthcheck", "readiness"] as const) {
      const healthcheck = service[role];
      if (healthcheck === undefined || healthcheck === false) continue;
      const invalid = authoredProbeTargetError(healthcheck, ServiceName.make(name), role);
      if (invalid !== undefined)
        issues.push({
          path: ["services", name, role],
          rule: `${role}.execution-target`,
          message: invalid.message,
          suggestion: invalid.remediation,
        });
      switch (healthcheck.kind) {
        case "http":
        case "tcp":
          issues.push({
            path: ["services", name, role, "kind"],
            rule: `landofile.${role}`,
            message: `Authored ${role} kind ${healthcheck.kind} is not supported by the healthcheck runner.`,
            suggestion: `Use kind: command with a probe command, or ${role}: false to disable the probe.`,
          });
          break;
        case "command":
        case "none":
        case undefined:
          break;
      }
    }
  }
  // Proxy entries need validation even when no service with that name was declared.
  for (const [name, entries] of Object.entries(landofile.proxy ?? {})) {
    if (routes.has(name)) continue;
    const normalized = checkRoutes(entries, ["proxy", name]);
    routes.set(name, normalized);
    for (const route of normalized) {
      issues.push({
        rule: "landofile.route",
        path: route.source?.path ?? ["proxy", name],
        message: `Proxy route ${route.hostname} targets undeclared service ${name}.`,
        suggestion: `Declare service ${name} under services:, or change proxy.${name} to an existing service name.`,
      });
    }
  }
  return { routes, issues: issues.map((issue) => attributePlannerIssue(landofile, issue)) };
};
