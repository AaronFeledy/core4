import { type NormalizedRoute, normalizeRoute } from "@lando/landofile/route-normalize";
import { getLandofileValueSource } from "@lando/landofile/validation";
import {
  DomainName,
  type LandofileShape,
  type RouteInput,
  ServiceName,
  type ValidationIssue,
  type ValidationIssuePath,
} from "@lando/sdk/schema";
import { Iterable, Result, Schema } from "effect";
import { deferredSiteKey } from "./landofile-scopes.ts";

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
}) => {
  const { landofile, blocked } = input;
  const issues: PlannerIssue[] = [];
  const routes = new Map<string, ReadonlyArray<NormalizedRoute> | undefined>();
  const isBlocked = (path: ValidationIssuePath) => {
    const key = deferredSiteKey(path);
    return Iterable.some(blocked, (site) => site === key || site.startsWith(`${key}.`));
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
  for (const [name, service] of Object.entries(landofile.services ?? {})) {
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
    const healthcheck = service.healthcheck;
    if (healthcheck !== undefined && healthcheck !== false) {
      switch (healthcheck.kind) {
        case "http":
        case "tcp":
          issues.push({
            path: ["services", name, "healthcheck", "kind"],
            rule: "landofile.healthcheck",
            message: `Authored healthcheck kind ${healthcheck.kind} is not supported by the healthcheck runner.`,
            suggestion:
              "Use kind: command with an in-container probe command, or healthcheck: false to disable the probe.",
          });
          break;
        case "command":
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
