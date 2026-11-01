import type { ConfigTranslateDiagnostic } from "@lando/sdk/schema";
import { CATALOG, type CatalogResolution, resolveCatalogType } from "./catalog.ts";
import { serviceCursor } from "./claims.ts";
import type { Lando3Path } from "./contract.ts";
import { lowerAssignments } from "./environment.ts";
import { withoutHostIpVariable } from "./host-reachability.ts";
import { lowerCatalogConfig } from "./lower-catalog-config.ts";
import { catalogVersionDiagnostics } from "./lower-catalog-version.ts";
import { type ListenPortResolution, resolveListenPort } from "./lower-listen-port.ts";
import { lowerScannerAndHome } from "./lower-runtime-intent.ts";
import { lowerServiceMemory } from "./lower-service-memory.ts";
import { lowerLegacySsl } from "./lower-ssl.ts";
import { lowerTomcatWebroot } from "./lower-tomcat-webroot.ts";
import {
  type LoweringPatch,
  type ServiceLoweringContext,
  hasPlainObjectPrototype,
} from "./lowering-contract.ts";
import {
  droppedMoreHttpPorts,
  rewrittenMeUser,
  rewrittenServiceKey,
  unsupportedServiceKey,
} from "./service-diagnostics.ts";

export interface CatalogCommonResult extends LoweringPatch {
  readonly resolution: CatalogResolution;
  readonly listenPort: ListenPortResolution | undefined;
}

const numericPort = (value: unknown): number | undefined => {
  const port = typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value;
  return typeof port === "number" && Number.isInteger(port) && port > 0 && port <= 65535 ? port : undefined;
};

export const lowerCatalogCommon = (
  service: Record<string, unknown>,
  ctx: ServiceLoweringContext,
): CatalogCommonResult => {
  const cursor = serviceCursor(service, ctx);
  const claimedContext = { ...ctx, cursor };
  cursor.take(["type"]);
  const resolution = resolveCatalogType(
    typeof service.type === "string" ? service.type : "",
    ctx.serviceFacts,
  );
  const patch: Record<string, unknown> = {};
  const diagnostics: ConfigTranslateDiagnostic[] = [];
  let blocked = false;
  const drop = (
    relative: Lando3Path,
    message: string,
    remediation = "Configure the equivalent behavior by hand in the generated service if needed.",
  ): void => {
    diagnostics.push(cursor.dropTree(relative, message, remediation));
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

  const versions = Object.hasOwn(ctx.serviceFacts, resolution.id)
    ? (ctx.serviceFacts[resolution.id]?.versions ?? [])
    : [];
  switch (resolution._tag) {
    case "resolved":
      patch.type = resolution.v4Type;
      if (resolution.renamedFrom !== undefined) {
        rewrite(["type"], `Renamed ${resolution.renamedFrom} to ${resolution.id}.`);
      }
      break;
    case "unsupported-version":
      blocked = true;
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
  diagnostics.push(...catalogVersionDiagnostics(resolution, ctx, versions));

  const entry = Object.hasOwn(CATALOG, resolution.id) ? CATALOG[resolution.id] : undefined;
  const facts = ctx.serviceFacts[resolution.id];
  const listenPort = resolveListenPort(service, facts, ctx);
  const publishedPort =
    numericPort(service.port) ??
    (listenPort?.kind === "literal" ? listenPort.port : undefined) ??
    facts?.listener?.port;
  cursor.take(["portforward"]);
  if (service.portforward !== undefined && service.portforward !== false) {
    const hostPort = numericPort(service.portforward);
    if (publishedPort === undefined) {
      drop(["portforward"], "Port forwarding has no catalog container port to publish.");
    } else if (service.portforward === true || hostPort !== undefined) {
      patch.ports = [service.portforward === true ? String(publishedPort) : `${hostPort}:${publishedPort}`];
      rewrite(["portforward"], "Rewrote portforward as a ports publication.");
    } else {
      drop(["portforward"], "Port forwarding requires true or a numeric host port.");
    }
  }

  const ssl = lowerLegacySsl(service, claimedContext);
  Object.assign(patch, ssl.patch);
  diagnostics.push(...ssl.diagnostics);

  if (service.environment !== undefined) {
    const environment = lowerAssignments(
      service.environment,
      { ctx: claimedContext, relative: ["environment"] },
      "environment",
    );
    diagnostics.push(...environment.diagnostics);
    patch.environment = withoutHostIpVariable(environment.entries, ctx, diagnostics);
  }

  for (const key of ["command", "user"] as const) {
    if (service[key] !== undefined) patch[key] = cursor.mapTo([key]);
  }
  if (service.creds !== undefined) {
    const creds = service.creds;
    if (
      hasPlainObjectPrototype(creds) &&
      ["user", "password", "database"].every((key) => typeof creds[key] === "string")
    ) {
      patch.creds = creds;
      for (const key of ["user", "password", "database"]) cursor.take(["creds", key]);
    } else {
      cursor.acceptNoOp(["creds"]);
      diagnostics.push(
        unsupportedServiceKey({
          ctx,
          relative: ["creds"],
          message: "Partial legacy credentials cannot form an independently valid native layer.",
          remediation: "Supply user, password, and database together before converting this layer.",
        }),
      );
    }
  }
  if (typeof service.meUser === "string") {
    cursor.take(["meUser"]);
    patch.user = service.meUser;
    diagnostics.push(rewrittenMeUser({ ctx }));
  }
  const appMountDisabled =
    service.app_mount === false || service.app_mount === "disabled" || service.app_mount === "off";
  if (resolution.id === "tomcat") {
    const webroot = lowerTomcatWebroot(service, claimedContext, appMountDisabled);
    Object.assign(patch, webroot.patch);
    diagnostics.push(...webroot.diagnostics);
  } else if (service.webroot !== undefined) patch.webroot = cursor.mapTo(["webroot"]);
  const port = numericPort(service.port);
  if (port !== undefined) patch.port = port;
  else if (Object.hasOwn(service, "port"))
    drop(["port"], "This value is not a TCP port number; Lando 3 never ran a server there.");
  cursor.take(["port"]);

  if (appMountDisabled) {
    cursor.take(["app_mount"]);
    patch.appMount = false;
    rewrite(["app_mount"], "Rewrote disabled app_mount as appMount: false.");
  } else if (["cached", "delegated", "consistent"].includes(String(service.app_mount))) {
    drop(["app_mount"], "Mount consistency hints have no Lando 4 appMount setting.");
  }

  const config = lowerCatalogConfig(service, { id: resolution.id, entry }, claimedContext);
  Object.assign(patch, config.patch);
  diagnostics.push(...config.diagnostics);

  for (const key of ["path", "scriptsDir"] as const) {
    if (Object.hasOwn(service, key)) drop([key], `${key} has no shared Lando 4 service setting.`);
  }
  if (Object.hasOwn(service, "moreHttpPorts")) {
    cursor.acceptNoOp(["moreHttpPorts"]);
    diagnostics.push(droppedMoreHttpPorts({ ctx, relative: ["moreHttpPorts"] }));
  }
  const memory = lowerServiceMemory(service, { id: resolution.id, patch }, claimedContext);
  Object.assign(patch, memory.patch);
  diagnostics.push(...memory.diagnostics);
  blocked ||= memory.blocked === true;
  const runtime = lowerScannerAndHome(service, claimedContext);
  Object.assign(patch, runtime.patch);
  diagnostics.push(...runtime.diagnostics);
  return {
    patch,
    claims: cursor.claims,
    diagnostics,
    resolution,
    listenPort,
    ...(config.companions === undefined ? {} : { companions: config.companions }),
    ...(blocked ? { blocked: true as const } : {}),
  };
};
