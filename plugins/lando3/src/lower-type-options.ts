import type { ConfigTranslateDiagnostic } from "@lando/sdk/schema";
import { serviceCursor } from "./claims.ts";
import {
  type LoweringPatch,
  type ServiceLoweringContext,
  asStringArray,
  hasPlainObjectPrototype,
} from "./lowering-contract.ts";
import { droppedServiceKey, rewrittenServiceKey, unsupportedServiceKey } from "./service-diagnostics.ts";

/** Lower only catalog-specific options; shared service fields belong to other lowerers. */
export const lowerTypeOptions = (
  catalogId: string,
  authored: Record<string, unknown>,
  ctx: ServiceLoweringContext,
): LoweringPatch => {
  const cursor = serviceCursor(authored, ctx);
  const service = Object.fromEntries(
    Object.entries(authored).filter(
      ([key]) => !Object.hasOwn(TYPE_OPTION_OWNERS, key) || TYPE_OPTION_OWNERS[key]?.includes(catalogId),
    ),
  );
  // Local accumulators keep field precedence and diagnostic order explicit.
  const patch: Record<string, unknown> = {};
  const diagnostics: ConfigTranslateDiagnostic[] = [];
  let blocked = false;

  switch (catalogId) {
    case "mysql":
    case "mariadb": {
      cursor.take(["authentication"]);
      if (typeof service.authentication === "string") {
        if (!/^[A-Za-z0-9_]+$/u.test(service.authentication)) {
          diagnostics.push(
            unsupportedServiceKey({
              ctx,
              relative: ["authentication"],
              message: "Authentication plugin names must be explicit identifiers.",
              remediation: "Use a plugin name such as mysql_native_password.",
            }),
          );
          break;
        }
        const directive = `default_authentication_plugin=${service.authentication}`;
        const run = `mkdir -p /etc/mysql/conf.d && printf '%s\\n' '[mysqld]' '${directive}' > /etc/mysql/conf.d/99-lando.cnf`;
        patch.build = { artifact: [{ user: "root", run }] };
        diagnostics.push(
          rewrittenServiceKey({
            ctx,
            relative: ["authentication"],
            message: `Authentication is written to /etc/mysql/conf.d/99-lando.cnf as ${directive}.`,
            remediation: "Review the generated artifact step before starting the database.",
          }),
        );
      }
      break;
    }
    case "solr": {
      cursor.take(["core"]);
      cursor.mapTo(["cores"]);
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
        cursor.mapTo([key]);
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
        cursor.take(["maxMessages"]);
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
      cursor.take(["password"]);
      cursor.take(["persist"]);
      if (typeof service.password === "string") patch.password = service.password;
      if (typeof service.persist === "boolean") patch.persist = service.persist;
      break;
    case "node":
      if (hasPlainObjectPrototype(service.globals)) {
        cursor.mapTo(["globals"]);
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
      cursor.mapTo(["hosts"]);
      const hosts = asStringArray(service.hosts);
      if (hosts !== undefined) patch.hosts = hosts;
      break;
    }
    case "varnish": {
      cursor.mapTo(["backends"]);
      cursor.take(["backend"]);
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
      if (service.backend === undefined && service.backends === undefined) {
        patch.backend = "appserver";
        diagnostics.push(
          rewrittenServiceKey({
            ctx,
            relative: ["type"],
            message: "Made Lando 3's implicit Varnish backend appserver explicit.",
            remediation: "Keep backend: appserver to preserve the default backend on port 80.",
          }),
        );
      }
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
      cursor.take(["webroot"]);
      cursor.take(["allowOverride"]);
      break;
    default:
      break;
  }

  for (const [key, owners] of Object.entries(TYPE_OPTION_OWNERS)) {
    if (Object.hasOwn(authored, key) && !owners.includes(catalogId))
      diagnostics.push(
        cursor.dropTree(
          [key],
          `Lando 3 ignored this option on ${catalogId}; it belongs to ${owners.join(", ")}.`,
          "Configure the intended behavior by hand on an appropriate Lando 4 service.",
        ),
      );
  }
  return { patch, claims: cursor.claims, diagnostics, ...(blocked ? { blocked: true as const } : {}) };
};

const TYPE_OPTION_OWNERS: Readonly<Record<string, readonly string[]>> = {
  via: ["php"],
  xdebug: ["php"],
  composer_version: ["php"],
  composer: ["php"],
  db_client: ["php"],
  authentication: ["mysql"],
  globals: ["node"],
  password: ["redis"],
  persist: ["redis"],
  core: ["solr"],
  mailFrom: ["mailpit"],
  hogfrom: ["mailhog"],
  maxMessages: ["mailpit"],
  hosts: ["phpmyadmin"],
  backends: ["varnish"],
  backend: ["varnish"],
  backend_port: ["varnish"],
};
