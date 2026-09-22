import type { ConfigTranslateDiagnostic } from "@lando/sdk/schema";
import {
  type LoweringPatch,
  type ServiceLoweringContext,
  asStringArray,
  emptyPatch,
  isPlainObject,
} from "./lowering-contract.ts";
import {
  droppedServiceKey,
  needsReviewServiceKey,
  rewrittenServiceKey,
  unsupportedServiceKey,
} from "./service-diagnostics.ts";

/** Lower only catalog-specific options; shared service fields belong to other lowerers. */
export const lowerTypeOptions = (
  catalogId: string,
  service: Record<string, unknown>,
  ctx: ServiceLoweringContext,
): LoweringPatch => {
  // Local accumulators keep field precedence and diagnostic order explicit.
  const patch: Record<string, unknown> = {};
  const diagnostics: ConfigTranslateDiagnostic[] = [];
  let blocked = false;

  switch (catalogId) {
    case "mysql":
    case "mariadb": {
      if (typeof service.authentication === "string") {
        const instruction = `Add default_authentication_plugin=${service.authentication} to the file mounted at config.server, which lands at /etc/mysql/conf.d/99-lando.cnf in the container.`;
        diagnostics.push(
          needsReviewServiceKey({
            ctx,
            relative: ["authentication"],
            message: `Authentication has no typed Lando 4 field and translation cannot write files. ${instruction}`,
            remediation: instruction,
          }),
        );
      }
      break;
    }
    case "solr": {
      if (typeof service.core === "string") {
        patch.cores = [service.core];
        diagnostics.push(
          rewrittenServiceKey({
            ctx,
            relative: ["core"],
            message: "The Solr core is now an entry in cores.",
            remediation: "Use cores to configure the Solr core names.",
          }),
        );
      }
      const cores = asStringArray(service.cores);
      if (cores !== undefined) patch.cores = cores;
      break;
    }
    case "mailpit":
    case "mailhog": {
      // Canonical mailFrom wins over sendFrom, which wins over hogfrom.
      for (const key of ["hogfrom", "sendFrom", "mailFrom"]) {
        const value = service[key];
        const mailFrom = value === false ? false : asStringArray(value);
        if (mailFrom === undefined) continue;
        patch.mailFrom = mailFrom;
        if (key !== "mailFrom") {
          diagnostics.push(
            rewrittenServiceKey({
              ctx,
              relative: [key],
              message: `${key} is renamed to mailFrom.`,
              remediation: "Use mailFrom with a service-name list, or false to disable mail routing.",
            }),
          );
        }
      }
      if (typeof service.maxMessages === "number") {
        patch.environment = { MP_MAX_MESSAGES: String(service.maxMessages) };
        diagnostics.push(
          rewrittenServiceKey({
            ctx,
            relative: ["maxMessages"],
            message: "maxMessages becomes the MP_MAX_MESSAGES environment variable.",
            remediation: "Set environment.MP_MAX_MESSAGES to change the message limit.",
          }),
        );
      }
      break;
    }
    case "redis":
      if (typeof service.password === "string") patch.password = service.password;
      if (typeof service.persist === "boolean") patch.persist = service.persist;
      break;
    case "node":
      if (isPlainObject(service.globals)) {
        patch.globals = Object.fromEntries(
          Object.entries(service.globals).map(([name, version]) => [name, String(version)]),
        );
        diagnostics.push(
          rewrittenServiceKey({
            ctx,
            relative: ["globals"],
            message: "Node globals become npm global installs with string versions.",
            remediation: "Review globals package versions for the npm global installs.",
          }),
        );
      }
      break;
    case "phpmyadmin": {
      const hosts = asStringArray(service.hosts);
      if (hosts !== undefined) patch.hosts = hosts;
      break;
    }
    case "varnish": {
      const backends = asStringArray(service.backends);
      if (backends !== undefined && backends.length > 1) {
        blocked = true;
        diagnostics.push(
          unsupportedServiceKey({
            ctx,
            relative: ["backends"],
            message: "Lando 4 Varnish supports a single backend; multiple backends cannot be converted.",
            remediation:
              "Configure a single backend, or author a custom Varnish service for multiple backends.",
          }),
        );
      } else if (backends?.length === 1) {
        patch.backend = backends[0];
        diagnostics.push(
          rewrittenServiceKey({
            ctx,
            relative: ["backends"],
            message: "The single backends entry becomes backend.",
            remediation: "Use backend with the target service name.",
          }),
        );
      }
      if (typeof service.backend === "string") patch.backend = service.backend;
      if (Object.hasOwn(service, "backend_port")) {
        diagnostics.push(
          droppedServiceKey({
            ctx,
            relative: ["backend_port"],
            message: "backend_port has no typed Lando 4 Varnish option and was dropped.",
            remediation: "Configure a custom Varnish configuration if the backend requires a different port.",
          }),
        );
      }
      break;
    }
    case "nginx":
    case "apache":
      if (typeof service.webroot === "string") patch.webroot = service.webroot;
      if (typeof service.allowOverride === "boolean") patch.allowOverride = service.allowOverride;
      break;
    default:
      return emptyPatch;
  }

  return { patch, diagnostics, ...(blocked ? { blocked: true as const } : {}) };
};
