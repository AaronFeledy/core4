import { isLegacyTagged } from "@lando/sdk/landofile";
import type { ConfigTranslateDiagnostic } from "@lando/sdk/schema";
import type { Lando3Path } from "./contract.ts";
import {
  type LoweringPatch,
  type ServiceLoweringContext,
  type V4Wire,
  asStringArray,
  isPlainObject,
} from "./lowering-contract.ts";
import {
  deferredServiceKey,
  droppedMoreHttpPorts,
  droppedServiceKey,
  rewrittenServiceKey,
  unsafeBuildSource,
  unsupportedServiceKey,
} from "./service-diagnostics.ts";

const entries = (value: unknown): readonly unknown[] => (Array.isArray(value) ? value : []);
const stringMap = (value: unknown): Readonly<Record<string, string>> =>
  Object.fromEntries(
    isPlainObject(value)
      ? Object.entries(value).map(([key, item]) => [key, String(item)])
      : (asStringArray(value) ?? []).map((item) => {
          const separator = item.indexOf("=");
          return separator < 0 ? [item, ""] : [item.slice(0, separator), item.slice(separator + 1)];
        }),
  );
const bind = (value: unknown): V4Wire | undefined => {
  if (typeof value === "string") {
    const match = /^(.*?):([^:]+?)(?::(ro|rw))?$/.exec(value);
    return match === null
      ? undefined
      : { source: match[1], target: match[2], ...(match[3] === "ro" ? { readOnly: true } : {}) };
  }
  if (!isPlainObject(value)) return undefined;
  const target = value.target ?? value.destination;
  if (typeof target !== "string") return undefined;
  return {
    ...(value.source === undefined ? {} : { source: value.source }),
    target,
    ...(typeof value.readOnly === "boolean" ? { readOnly: value.readOnly } : {}),
    ...(value.includes === undefined ? {} : { includes: value.includes }),
    ...(value.excludes === undefined ? {} : { excludes: value.excludes }),
  };
};

/** Pure API-4 authoring translation; sibling lowerers own hooks and Compose overrides. */
export const lowerApi4Service = (
  service: Record<string, unknown>,
  ctx: ServiceLoweringContext,
): LoweringPatch => {
  // Local accumulators preserve authored array order without mutating the input.
  const patch: Record<string, unknown> = { type: "lando" };
  const diagnostics: ConfigTranslateDiagnostic[] = [];
  let blocked = false;
  const drop = (relative: Lando3Path): void => {
    diagnostics.push(
      droppedServiceKey({
        ctx,
        relative,
        message: "This setting is omitted from the converted service.",
        remediation: "Review the generated service and configure the equivalent behavior manually.",
      }),
    );
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
  if (typeof image === "string") patch.image = image;
  else if (isPlainObject(image) && !isLegacyTagged(image)) {
    const build: Record<string, unknown> = { context: "." };
    for (const [key, target] of [
      ["imagefile", "dockerfileInline"],
      ["dockerfile", "dockerfile"],
    ] as const) {
      if (typeof image[key] === "string") {
        build[target] = image[key];
        rewrite(["image", key]);
      }
    }
    if (image.args !== undefined) build.args = stringMap(image.args);
    if (Object.keys(build).length > 1) patch.build = build;
    if (image.ssh) unsafe(["image", "ssh"]);
    entries(image.context).forEach((item, index) => {
      const source = isPlainObject(item) ? (item.source ?? item.src) : item;
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
    if (isLegacyTagged(value) || entries(value).some(isLegacyTagged)) {
      rejectTag([key]);
      blocked = true;
    } else if (value !== undefined) patch[key] = value;
  }
  for (const key of ["user", "primary", "hostnames", "labels", "certs", "volumes", "networks"]) {
    if (service[key] !== undefined) patch[key] = service[key];
  }
  if (service.working_dir !== undefined) {
    patch.workingDirectory = service.working_dir;
    rewrite(["working_dir"]);
  }
  if (service.environment !== undefined) patch.environment = stringMap(service.environment);
  const appKey = service["app-mount"] !== undefined ? "app-mount" : "appMount";
  const app = service[appKey];
  if (app === false || app === "disabled" || app === "off") patch.appMount = false;
  else if (typeof app === "string") patch.appMount = { target: app };
  else if (isPlainObject(app)) {
    const excludes = [...ctx.topLevel.excludes, ...(asStringArray(app.excludes) ?? [])];
    const includes = [
      ...ctx.topLevel.includes,
      ...(asStringArray(app.includes) ?? []),
      ...excludes.filter((item) => item.startsWith("!")).map((item) => item.slice(1)),
    ];
    patch.appMount = {
      target: app.destination ?? app.target,
      ...(excludes.length > 0 ? { excludes: excludes.filter((item) => !item.startsWith("!")) } : {}),
      ...(includes.length > 0 ? { includes } : {}),
    };
    if (app.type === "copy") drop([appKey, "type"]);
  }
  const mounts: V4Wire[] = [];
  entries(service.mounts).forEach((item, index) => {
    if (isPlainObject(item)) {
      if (item.source === undefined && (item.contents !== undefined || item.content !== undefined)) {
        drop(["mounts", index]);
        return;
      }
      if (item.type === "copy") drop(["mounts", index, "type"]);
      if (item.group !== undefined) drop(["mounts", index, "group"]);
    }
    const mount = bind(item);
    if (mount !== undefined) mounts.push(mount);
  });
  const storage: V4Wire[] = [];
  for (const key of ["storage", "persistent-storage"]) {
    if (key === "persistent-storage" && service[key] !== undefined) rewrite([key]);
    entries(service[key]).forEach((item, index) => {
      if (isPlainObject(item) && item.type === "image") {
        drop([key, index]);
        return;
      }
      const mount = bind(item);
      if ((typeof item === "string" && item.includes(":")) || (isPlainObject(item) && item.type === "bind")) {
        if (mount !== undefined) mounts.push(mount);
        return;
      }
      const target =
        typeof item === "string" ? item : isPlainObject(item) ? (item.target ?? item.destination) : undefined;
      if (typeof target !== "string") return;
      storage.push({
        store:
          isPlainObject(item) && typeof item.source === "string"
            ? item.source
            : target
                .toLowerCase()
                .replace(/[^a-z0-9]+/g, "-")
                .replace(/^-|-$/g, ""),
        target,
        ...(isPlainObject(item) && item.scope !== undefined ? { scope: item.scope } : {}),
      });
    });
  }
  if (mounts.length > 0) patch.mounts = mounts;
  if (storage.length > 0) patch.storage = storage;
  if (isPlainObject(service.security)) {
    const ca: unknown[] = [];
    for (const key of ["ca", "cas", "certificate-authority", "certificate-authorities"]) {
      const value = service.security[key];
      if (value === undefined) continue;
      if (key !== "ca") rewrite(["security", key]);
      (Array.isArray(value) ? value : [value]).forEach((item: unknown, index) => {
        if (isLegacyTagged(item)) rejectTag(["security", key, index]);
        else ca.push(item);
      });
    }
    patch.security = { ca };
  }
  if (isPlainObject(service.packages))
    for (const key of Object.keys(service.packages)) drop(["packages", key]);
  const health = service.healthcheck;
  if (health === false) patch.healthcheck = { kind: "none" };
  else if (typeof health === "string") patch.healthcheck = { command: health };
  else if (isPlainObject(health)) {
    patch.healthcheck = {
      ...(health.command === undefined ? {} : { command: health.command }),
      ...(health.retry === undefined ? {} : { retries: health.retry }),
      ...(typeof health.delay === "number" ? { intervalSeconds: Math.round(health.delay / 1000) } : {}),
    };
    if (health.user !== undefined) drop(["healthcheck", "user"]);
  }
  const endpoints: V4Wire[] = [];
  const ports: unknown[] = [];
  for (const port of entries(service.ports)) {
    const internal = typeof port === "string" ? /^(\d+)\/(https?)$/.exec(port) : null;
    const published = typeof port === "string" ? /^0:(\d+)$/.exec(port) : null;
    if (internal !== null)
      endpoints.push({ _tag: "internal", protocol: internal[2], port: Number(internal[1]) });
    else if (published !== null)
      endpoints.push({ _tag: "published", protocol: "tcp", port: Number(published[1]), publication: {} });
    else ports.push(port);
  }
  if (endpoints.length > 0) {
    patch.endpoints = endpoints;
    rewrite(["ports"]);
  }
  if (ports.length > 0) patch.ports = ports;
  if (service.moreHttpPorts !== undefined) {
    diagnostics.push(droppedMoreHttpPorts({ ctx, relative: ["moreHttpPorts"] }));
  }
  for (const key of ["scanner", "home"] as const) {
    if (service[key] !== undefined) diagnostics.push(deferredServiceKey({ ctx, relative: [key], key }));
  }
  return { patch, diagnostics, ...(blocked ? { blocked: true as const } : {}) };
};
