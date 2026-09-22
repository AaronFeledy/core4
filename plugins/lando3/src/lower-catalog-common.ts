import type { ConfigTranslateDiagnostic } from "@lando/sdk/schema";
import { CATALOG, type CatalogEntry, type CatalogResolution, resolveCatalogType } from "./catalog.ts";
import type { Lando3Path } from "./contract.ts";
import {
  type LoweringPatch,
  type ServiceLoweringContext,
  type V4Wire,
  asStringArray,
  containerWebroot,
  isPlainObject,
} from "./lowering-contract.ts";
import {
  deferredServiceKey,
  droppedServiceKey,
  rewrittenServiceKey,
  unsupportedServiceKey,
  unsupportedVersion,
} from "./service-diagnostics.ts";

export interface CatalogCommonResult extends LoweringPatch {
  readonly resolution: CatalogResolution;
}

const numericPort = (value: unknown): number | undefined => {
  const port = typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value;
  return typeof port === "number" && Number.isInteger(port) && port > 0 && port <= 65535 ? port : undefined;
};

const readOnlyBind = (source: string, target: string): V4Wire => ({
  type: "bind",
  source,
  target,
  readOnly: true,
});

const configMount = (
  id: string,
  key: string,
  service: Record<string, unknown>,
  entry: CatalogEntry | undefined,
): { readonly target: string; readonly companion: boolean } | undefined => {
  if (id === "php") {
    const via = service.via;
    const nginx = via === "nginx" || (typeof via === "string" && via.startsWith("nginx:"));
    if (key === "php")
      return { target: "/usr/local/etc/php/conf.d/zzz-lando-my-custom.ini", companion: false };
    if (key === "pool") return { target: "/usr/local/etc/php-fpm.d/zz-lando.conf", companion: false };
    if (key === "vhosts") {
      return {
        target: nginx ? "/etc/nginx/conf.d/default.conf" : "/etc/apache2/sites-enabled/000-default.conf",
        companion: nginx,
      };
    }
    if (key === "server") {
      return { target: nginx ? "/etc/nginx/nginx.conf" : "/etc/apache2/apache2.conf", companion: nginx };
    }
    return undefined;
  }
  const target = entry?.configMounts?.[key];
  return target === undefined ? undefined : { target, companion: false };
};

export const lowerCatalogCommon = (
  service: Record<string, unknown>,
  ctx: ServiceLoweringContext,
): CatalogCommonResult => {
  const resolution = resolveCatalogType(typeof service.type === "string" ? service.type : "");
  const patch: Record<string, unknown> = {};
  const diagnostics: ConfigTranslateDiagnostic[] = [];
  let blocked = false;
  let companions: Record<string, V4Wire> | undefined;
  const drop = (relative: Lando3Path, message: string): void => {
    diagnostics.push(
      droppedServiceKey({
        ctx,
        relative,
        message,
        remediation: "Configure the equivalent behavior by hand in the generated service if needed.",
      }),
    );
  };
  const rewrite = (relative: Lando3Path, message: string): void => {
    diagnostics.push(
      rewrittenServiceKey({
        ctx,
        relative,
        message,
        remediation: "Review the generated service fields before starting the app.",
      }),
    );
  };

  switch (resolution._tag) {
    case "resolved":
      patch.type = resolution.v4Type;
      if (resolution.renamedFrom !== undefined) {
        rewrite(["type"], `Renamed ${resolution.renamedFrom} to ${resolution.id}.`);
      }
      break;
    case "unsupported-version":
      blocked = true;
      diagnostics.push(
        unsupportedVersion({
          ctx,
          relative: ["type"],
          type: resolution.id,
          version: resolution.version,
          supported: resolution.supported,
        }),
      );
      break;
    case "unknown-type":
      blocked = true;
      diagnostics.push(
        unsupportedServiceKey({
          ctx,
          relative: ["type"],
          message: `Service type ${resolution.id} is not in the Lando 4 catalog.`,
          remediation: "Choose a supported service type or provide an explicit overrides.image.",
        }),
      );
      break;
    default:
      return resolution satisfies never;
  }

  const entry = Object.hasOwn(CATALOG, resolution.id) ? CATALOG[resolution.id] : undefined;
  if (service.portforward !== undefined && service.portforward !== false) {
    const hostPort = numericPort(service.portforward);
    if (entry?.containerPort === undefined) {
      drop(["portforward"], "Port forwarding has no catalog container port to publish.");
    } else if (service.portforward === true || hostPort !== undefined) {
      patch.ports = [
        service.portforward === true ? String(entry.containerPort) : `${hostPort}:${entry.containerPort}`,
      ];
      rewrite(["portforward"], "Rewrote portforward as a ports publication.");
    } else {
      drop(["portforward"], "Port forwarding requires true or a numeric host port.");
    }
  }

  const sslPort = numericPort(service.sport) ?? numericPort(service.ssl);
  if (typeof service.ssl === "boolean" || sslPort !== undefined) {
    patch.certs = sslPort !== undefined || service.ssl === true;
    if (sslPort !== undefined) {
      patch.endpoints = [
        service.sslExpose
          ? { _tag: "published", protocol: "https", port: sslPort, publication: {} }
          : { _tag: "internal", protocol: "https", port: sslPort },
      ];
    }
    rewrite(
      [service.ssl === undefined ? "sport" : "ssl"],
      "Rewrote SSL settings as certs and explicit HTTPS endpoints where a port was provided.",
    );
  }

  if (isPlainObject(service.environment) || Array.isArray(service.environment)) {
    const environment = new Map<string, string>();
    if (isPlainObject(service.environment)) {
      for (const [key, value] of Object.entries(service.environment)) {
        if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
          environment.set(key, String(value));
        } else {
          drop(["environment", key], "Environment entry has no explicit scalar value.");
        }
      }
    } else {
      for (const [index, assignment] of (asStringArray(service.environment) ?? []).entries()) {
        const separator = assignment.indexOf("=");
        if (separator > 0) {
          environment.set(assignment.slice(0, separator), assignment.slice(separator + 1));
        } else {
          drop(["environment", index], "Environment entry requires an explicit KEY=value assignment.");
        }
      }
    }
    patch.environment = Object.fromEntries(environment);
  }

  for (const key of ["command", "creds", "user"] as const) {
    if (service[key] !== undefined) patch[key] = service[key];
  }
  if (service.webroot !== undefined) {
    const webroot = containerWebroot(service.webroot);
    patch.webroot = webroot ?? service.webroot;
    if (webroot !== undefined && webroot !== service.webroot) {
      rewrite(["webroot"], `Rewrote the app-relative webroot as the container path ${webroot}.`);
    }
  }
  const port = numericPort(service.port);
  if (port !== undefined) patch.port = port;

  if (service.app_mount === false || service.app_mount === "disabled" || service.app_mount === "off") {
    patch.appMount = false;
    rewrite(["app_mount"], "Rewrote disabled app_mount as appMount: false.");
  } else if (["cached", "delegated", "consistent"].includes(String(service.app_mount))) {
    drop(["app_mount"], "Mount consistency hints have no Lando 4 appMount setting.");
  }

  if (isPlainObject(service.config)) {
    const config: { server?: string; dir?: string } = {};
    const mounts: V4Wire[] = [];
    const companionMounts: V4Wire[] = [];
    for (const [key, value] of Object.entries(service.config)) {
      const mounted = configMount(resolution.id, key, service, entry);
      if (mounted !== undefined) {
        if (typeof value !== "string") {
          drop(["config", key], "Config slot requires a host path string.");
          continue;
        }
        const mount = readOnlyBind(value, mounted.target);
        if (mounted.companion) companionMounts.push(mount);
        else mounts.push(mount);
        rewrite(["config", key], `Mounted ${key} read-only at ${mounted.target}.`);
        continue;
      }
      const slot =
        entry?.configKeys !== undefined && Object.hasOwn(entry.configKeys, key)
          ? entry.configKeys[key]
          : undefined;
      switch (slot) {
        case "server":
        case "dir":
          if (typeof value === "string") config[slot] = value;
          else drop(["config", key], "Config slot requires a host path string.");
          break;
        case "drop":
        case undefined:
          drop(["config", key], `Config slot ${key} has no Lando 4 mapping for ${resolution.id}.`);
          break;
        default:
          slot satisfies never;
      }
    }
    if (mounts.length > 0) patch.mounts = mounts;
    if (companionMounts.length > 0) {
      companions = { [`${ctx.serviceName}-nginx`]: { type: "nginx", mounts: companionMounts } };
    }
    if (Object.keys(config).length > 0) {
      patch.config = config;
      rewrite(
        ["config"],
        entry?.configDestination === undefined
          ? `Rewrote config slots to the ${resolution.id} service's file configuration.`
          : `Rewrote config slots to file configuration mounted at ${entry.configDestination}.`,
      );
    }
  }

  for (const key of ["path", "scriptsDir"] as const) {
    if (Object.hasOwn(service, key)) drop([key], `${key} has no shared Lando 4 service setting.`);
  }
  for (const key of ["scanner", "moreHttpPorts", "home", "mem", "plugins"] as const) {
    if (Object.hasOwn(service, key)) diagnostics.push(deferredServiceKey({ ctx, relative: [key] }));
  }
  return {
    patch,
    diagnostics,
    resolution,
    ...(companions === undefined ? {} : { companions }),
    ...(blocked ? { blocked: true as const } : {}),
  };
};
