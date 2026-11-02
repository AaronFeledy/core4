import { isLegacyTagged } from "@lando/sdk/landofile";
import type { ConfigTranslateDiagnostic } from "@lando/sdk/schema";
import { serviceCursor } from "./claims.ts";
import { splitStringArgv } from "./compose-command.ts";
import { lowerComposeFields } from "./compose-fields.ts";
import type { Lando3Path } from "./contract.ts";
import { lowerAssignments } from "./environment.ts";
import { withoutHostIpVariable } from "./host-reachability.ts";
import { lowerApi4Mounts } from "./lower-api4-mounts.ts";
import { lowerHealthcheck } from "./lower-healthcheck.ts";
import { lowerL337 } from "./lower-l337.ts";
import { lowerScannerAndHome } from "./lower-runtime-intent.ts";
import {
  type LoweringPatch,
  type ServiceLoweringContext,
  type V4Wire,
  hasPlainObjectPrototype,
} from "./lowering-contract.ts";
import {
  droppedMoreHttpPorts,
  rejectedComposeKey,
  rewrittenServiceKey,
  unsafeBuildSource,
  unsupportedServiceKey,
} from "./service-diagnostics.ts";

const entries = (value: unknown): readonly unknown[] => (Array.isArray(value) ? value : []);

/** Pure API-4 authoring translation; sibling lowerers own hooks and Compose overrides. */
export const lowerApi4Service = (
  service: Record<string, unknown>,
  ctx: ServiceLoweringContext,
): LoweringPatch => {
  const cursor = serviceCursor(service, ctx);
  cursor.take(["api"]);
  cursor.take(["type"]);
  // Local accumulators preserve authored array order without mutating the input.
  const patch: Record<string, unknown> = { type: "lando" };
  const diagnostics: ConfigTranslateDiagnostic[] = [];
  let blocked = false;
  const drop = (relative: Lando3Path): void => {
    diagnostics.push(
      cursor.dropTree(
        relative,
        "This setting is omitted from the converted service.",
        "Review the generated service and configure the equivalent behavior manually.",
      ),
    );
  };
  const dropOwned = (item: Record<string, unknown>, relative: Lando3Path): void => {
    for (const key of ["owner", "permissions", "user", "group", "contents", "content"] as const) {
      if (item[key] !== undefined) drop([...relative, key]);
    }
  };
  const rewrite = (relative: Lando3Path): void => {
    diagnostics.push(
      rewrittenServiceKey({
        ctx,
        relative,
        message: "This setting was rewritten to Lando 4 authoring fields.",
        remediation: "Review the generated field before starting the service.",
      }),
    );
  };
  const rejectTag = (relative: Lando3Path): void => {
    cursor.acceptNoOp(relative);
    diagnostics.push(
      unsupportedServiceKey({
        ctx,
        relative,
        message: "Tagged file references cannot be converted here.",
        remediation:
          "Replace the reference with an explicit value; referenced files are never read during conversion.",
      }),
    );
  };
  const unsafe = (relative: Lando3Path): void => {
    cursor.acceptNoOp(relative);
    diagnostics.push(
      unsafeBuildSource({
        ctx,
        relative,
        detail: "Remote contexts and host SSH forwarding are not allowed.",
      }),
    );
    blocked = true;
  };
  const image = service.image;
  cursor.take(["image"]);
  if (typeof image === "string") patch.image = image;
  else if (hasPlainObjectPrototype(image) && !isLegacyTagged(image)) {
    const build: Record<string, unknown> = { context: "." };
    for (const [key, target] of [
      ["imagefile", "dockerfileInline"],
      ["dockerfile", "dockerfile"],
    ] as const) {
      if (typeof image[key] === "string") {
        cursor.take(["image", key]);
        build[target] = image[key];
        rewrite(["image", key]);
      }
    }
    if (image.args !== undefined) {
      const args = lowerAssignments(
        image.args,
        { ctx: { ...ctx, cursor }, relative: ["image", "args"] },
        "build-args",
      );
      diagnostics.push(...args.diagnostics);
      build.args = Object.fromEntries(args.entries.map(({ name, value }) => [name, value]));
    }
    if (Object.keys(build).length > 1) patch.build = build;
    if (image.ssh) unsafe(["image", "ssh"]);
    else cursor.acceptNoOp(["image", "ssh"]);
    for (const key of ["context", "groups", "steps"]) cursor.take(["image", key]);
    entries(image.context).forEach((item, index) => {
      if (hasPlainObjectPrototype(item)) dropOwned(item, ["image", "context", index]);
      const source = hasPlainObjectPrototype(item) ? (item.source ?? item.src) : item;
      if (typeof source === "string" && (source.includes("://") || source.startsWith("git@")))
        unsafe(["image", "context", index]);
      else drop(["image", "context", index]);
    });
    for (const key of ["tag", "buildx", "buildkit"]) if (image[key] !== undefined) drop(["image", key]);
    for (const key of ["groups", "steps"])
      entries(image[key]).forEach((_, index) => drop(["image", key, index]));
  }
  for (const key of ["command", "entrypoint"]) {
    const value = service[key];
    cursor.mapTo([key]);
    if (isLegacyTagged(value) || entries(value).some(isLegacyTagged)) {
      rejectTag([key]);
      blocked = true;
    } else if (service.type === "l337" && value !== undefined) {
      const lowered = lowerComposeFields({ [key]: value }, ctx, { basePath: [] });
      Object.assign(patch, lowered.patch);
      diagnostics.push(...lowered.diagnostics);
      blocked ||= lowered.blocked === true;
    } else if (typeof value === "string" && value.length > 0 && !value.includes("\n")) {
      // Lando 3 ran a multi-line value as a mounted script, so only a single line splits.
      patch[key] = splitStringArgv(value);
      diagnostics.push(
        rewrittenServiceKey({
          ctx,
          relative: [key],
          message: `Split single-line ${key} into arguments as Lando 3 did, so it runs without a shell.`,
          remediation: "Keep the argument list; a Lando 4 string command runs as a shell script.",
        }),
      );
    } else if (value !== undefined) patch[key] = value;
  }
  for (const key of ["user", "primary", "hostnames", "certs", "volumes", "networks"]) {
    if (service[key] !== undefined) patch[key] = cursor.mapTo([key]);
  }
  if (service.working_dir !== undefined) {
    cursor.take(["working_dir"]);
    patch.workingDirectory = service.working_dir;
    rewrite(["working_dir"]);
  }
  if (service.environment !== undefined) {
    const environment = lowerAssignments(
      service.environment,
      { ctx: { ...ctx, cursor }, relative: ["environment"] },
      "environment",
    );
    diagnostics.push(...environment.diagnostics);
    patch.environment = withoutHostIpVariable(environment.entries, ctx, diagnostics);
  }
  if (service.labels !== undefined) {
    const labels = lowerAssignments(
      service.labels,
      { ctx: { ...ctx, cursor }, relative: ["labels"] },
      "labels",
    );
    diagnostics.push(...labels.diagnostics);
    patch.labels = Object.fromEntries(labels.entries.map(({ name, value }) => [name, value]));
  }
  const mountService =
    service.type === "l337"
      ? Object.fromEntries(
          Object.entries(service).filter(([key]) => !["appMount", "appmount", "app-mount"].includes(key)),
        )
      : service;
  const mounts = lowerApi4Mounts(mountService, {
    ...ctx,
    cursor,
    ...(service.type === "l337" ? { topLevel: { excludes: [], includes: [] } } : {}),
  });
  Object.assign(patch, mounts.patch);
  diagnostics.push(...mounts.diagnostics);
  blocked ||= mounts.blocked === true;
  if (Object.hasOwn(service, "endpoints"))
    diagnostics.push(
      cursor.dropTree(
        ["endpoints"],
        "Lando 3 ignored endpoints on API-4 services.",
        "Declare Lando 4 endpoints by hand if this service needs them.",
      ),
    );
  if (hasPlainObjectPrototype(service.security)) {
    cursor.take(["security"]);
    const ca: unknown[] = [];
    for (const key of ["ca", "cas", "certificate-authority", "certificate-authorities"]) {
      const value = service.security[key];
      if (value === undefined) continue;
      cursor.mapTo(["security", key]);
      if (key !== "ca") rewrite(["security", key]);
      (Array.isArray(value) ? value : [value]).forEach((item: unknown, index) => {
        if (isLegacyTagged(item)) rejectTag(["security", key, index]);
        else ca.push(item);
      });
    }
    patch.security = { ca };
  }
  if (hasPlainObjectPrototype(service.packages)) {
    cursor.take(["packages"]);
    for (const key of Object.keys(service.packages)) drop(["packages", key]);
  }
  const health = lowerHealthcheck(service, { ...ctx, cursor });
  Object.assign(patch, health.patch);
  diagnostics.push(...health.diagnostics);
  blocked ||= health.blocked === true;
  const endpoints: V4Wire[] = [];
  cursor.mapTo(["ports"]);
  const ports: unknown[] = [];
  for (const port of entries(service.ports)) {
    const published =
      typeof port === "string"
        ? /^(?:(?:([^:]+|\[[^\]]+\]):)?(\d*):)?(\d+)(?:\/(https?|tcp|udp))?$/.exec(port)
        : null;
    if (published !== null && (published[4] !== undefined || published[2] === "0")) {
      const [, bindAddress, hostPort, target, protocol] = published;
      // Lando 3 published every ports entry, using TCP for HTTP(S) and zero for random host ports.
      endpoints.push({
        _tag: "published",
        protocol: protocol ?? "tcp",
        port: Number(target),
        publication: {
          ...(bindAddress === undefined ? {} : { bindAddress: bindAddress.replace(/^\[|\]$/g, "") }),
          ...(hostPort === undefined || hostPort === "" || Number(hostPort) === 0
            ? {}
            : { hostPort: Number(hostPort) }),
        },
      });
    } else ports.push(port);
  }
  if (endpoints.length > 0) {
    patch.endpoints = endpoints;
    rewrite(["ports"]);
  }
  if (ports.length > 0) patch.ports = ports;
  if (service.moreHttpPorts !== undefined) {
    cursor.acceptNoOp(["moreHttpPorts"]);
    diagnostics.push(droppedMoreHttpPorts({ ctx, relative: ["moreHttpPorts"] }));
  }
  const runtime = lowerScannerAndHome(service, { ...ctx, cursor });
  Object.assign(patch, runtime.patch);
  diagnostics.push(...runtime.diagnostics);
  for (const key of ["tty", "stdin_open"]) {
    if (!Object.hasOwn(service, key)) continue;
    diagnostics.push(rejectedComposeKey({ ctx, relative: [key], key }));
    blocked = true;
  }
  const result = {
    patch,
    claims: cursor.claims,
    diagnostics,
    ...(blocked ? { blocked: true as const } : {}),
  };
  return service.type === "l337" ? lowerL337(service, result, ctx) : result;
};
