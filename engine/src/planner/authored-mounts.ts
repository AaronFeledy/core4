import { homedir } from "node:os";
import { isAbsolute, resolve, win32 } from "node:path";
import { LandofileValidationError } from "@lando/sdk/errors";
import {
  type ComposeVolumeEntry,
  type MountInput,
  type MountPlan,
  type ServiceConfig,
  type ValidationIssuePath,
  parseShortVolume,
  validationIssue,
} from "@lando/sdk/schema";
import { Schema, SchemaIssue } from "effect";
import { kebab } from "./naming.ts";
import { plannedContainerDestination } from "./storage.ts";

export interface MountAuthoringContext {
  readonly appRoot: string;
  readonly appSlug: string;
  readonly serviceName: string;
}

export const mountInputError = (
  context: MountAuthoringContext,
  paths: readonly ValidationIssuePath[],
  message: string,
  remediation: string,
): LandofileValidationError =>
  new LandofileValidationError({
    message,
    remediation,
    file: `${context.appRoot}/.lando.yml`,
    issues: paths.map((path) => validationIssue(path, message, remediation)),
  });

const bindSource = (source: string, appRoot: string): string => {
  const expanded =
    source === "~" ? homedir() : source.startsWith("~/") ? homedir() + source.slice(1) : source;
  if (isAbsolute(expanded) || win32.isAbsolute(expanded)) return expanded;
  return /^[A-Za-z]:[\\/]/u.test(appRoot) || appRoot.startsWith("\\\\")
    ? win32.resolve(appRoot, expanded)
    : resolve(appRoot, expanded);
};

export const normalizeTmpfs = (
  input: { readonly target: MountPlan["target"]; readonly readOnly: boolean; readonly options?: string },
  context: MountAuthoringContext,
  path: ValidationIssuePath,
): MountPlan | LandofileValidationError => {
  const tokens = (input.options ?? "").split(",").filter((token) => token.length > 0);
  if (tokens.includes("ro") && tokens.includes("rw"))
    return mountInputError(
      context,
      [path],
      "Tmpfs options cannot contain both ro and rw.",
      "Choose either ro or rw for this tmpfs mount.",
    );
  const options = tokens.filter((token) => token !== "ro" && token !== "rw").join(",");
  return {
    type: "tmpfs",
    target: input.target,
    readOnly: tokens.includes("ro") || (!tokens.includes("rw") && input.readOnly),
    ...(options.length === 0 ? {} : { options }),
  };
};

const classifyMount = (
  input: MountInput | ComposeVolumeEntry,
  context: MountAuthoringContext,
  path: ValidationIssuePath,
): MountPlan | LandofileValidationError => {
  let entry: Exclude<MountInput, string> | ComposeVolumeEntry;
  try {
    entry = typeof input === "string" ? parseShortVolume(input) : input;
  } catch (cause) {
    if (!(cause instanceof SchemaIssue.InvalidValue)) throw cause;
    return mountInputError(
      context,
      [path],
      new Schema.SchemaError(cause).message,
      "Use source:target[:mode] mount syntax.",
    );
  }
  const target = plannedContainerDestination(entry.target, context.appRoot, path);
  if (target instanceof LandofileValidationError) return target;
  const type = entry.type ?? "bind";
  const excludes = "excludes" in entry ? entry.excludes : undefined;
  const includes = "includes" in entry ? entry.includes : undefined;
  if (type !== "bind" && (excludes !== undefined || includes !== undefined))
    return mountInputError(
      context,
      [path],
      "Mount excludes and includes apply only to bind mounts.",
      "Remove excludes/includes or change this mount to a host bind.",
    );
  for (const [key, entries] of [
    ["excludes", excludes],
    ["includes", includes],
  ] as const) {
    if (entries?.some((value) => value.startsWith("!")))
      return mountInputError(
        context,
        [[...path, key]],
        "Mount excludes and includes do not accept ! entries.",
        "Move negated excludes to includes and remove the ! prefix.",
      );
  }
  switch (type) {
    case "bind":
      if (entry.source === undefined)
        return mountInputError(
          context,
          [path],
          `Bind mount at ${target} requires a source.`,
          "Set source to a host path.",
        );
      return {
        type,
        target,
        source: bindSource(entry.source, context.appRoot),
        readOnly: entry.readOnly ?? false,
        realization: "passthrough",
        ...("createHostPath" in entry && entry.createHostPath === false ? { createHostPath: false } : {}),
        ...(excludes === undefined ? {} : { excludes }),
        ...(includes === undefined ? {} : { includes }),
      };
    case "volume":
      return {
        type,
        target,
        store:
          entry.source === undefined
            ? `${context.appSlug}-${context.serviceName}-${kebab(target)}`
            : `${context.appSlug}-${entry.source}`,
        readOnly: entry.readOnly ?? false,
        ...("subpath" in entry && entry.subpath !== undefined ? { subpath: entry.subpath } : {}),
      };
    case "tmpfs": {
      const tmpfs = "tmpfs" in entry ? entry.tmpfs : undefined;
      const options = [
        tmpfs?.size === undefined ? undefined : `size=${tmpfs.size}`,
        tmpfs?.mode === undefined ? undefined : `mode=${tmpfs.mode.toString(8)}`,
      ]
        .filter((token) => token !== undefined)
        .join(",");
      return normalizeTmpfs({ target, readOnly: entry.readOnly ?? false, options }, context, path);
    }
  }
};

export const compileAuthoredMounts = (
  context: MountAuthoringContext,
  normalized: ServiceConfig,
  storage: ServiceConfig["storage"],
): readonly MountPlan[] | LandofileValidationError => {
  const lando = new Map<string, { readonly mount: MountPlan; readonly path: ValidationIssuePath }>();
  const compose = new Map<string, MountPlan>();
  const add = (mount: MountPlan, path: ValidationIssuePath): LandofileValidationError | undefined => {
    const previous = lando.get(mount.target);
    if (previous !== undefined)
      return mountInputError(
        context,
        [previous.path, path],
        `Multiple Lando mounts claim ${mount.target}.`,
        "Keep only one mounts, storage, or tmpfs entry at this destination.",
      );
    lando.set(mount.target, { mount, path });
  };
  for (const [index, entry] of (storage ?? []).entries()) {
    const path = ["services", context.serviceName, "storage", index];
    const target = plannedContainerDestination(
      typeof entry === "string" ? entry : entry.target,
      context.appRoot,
      path,
    );
    if (target instanceof LandofileValidationError) return target;
    const store =
      typeof entry === "string"
        ? kebab(entry)
        : entry.kind === "cache"
          ? `lando-cache-${entry.key ?? kebab(target)}`
          : entry.store;
    const error = add(
      {
        type: "volume",
        store,
        target,
        readOnly: typeof entry === "string" ? false : (entry.readOnly ?? false),
      },
      path,
    );
    if (error !== undefined) return error;
  }
  for (const key of ["mounts", "volumes"] as const) {
    for (const [index, entry] of (normalized[key] ?? []).entries()) {
      const path = ["services", context.serviceName, key, index];
      const mount = classifyMount(entry, context, path);
      if (mount instanceof LandofileValidationError) return mount;
      if (key === "volumes") compose.set(mount.target, mount);
      else {
        const error = add(mount, path);
        if (error !== undefined) return error;
      }
    }
  }
  for (const [index, entry] of (normalized.tmpfs ?? []).entries()) {
    const path = ["services", context.serviceName, "tmpfs", index];
    const separator = entry.indexOf(":");
    const target = plannedContainerDestination(
      separator === -1 ? entry : entry.slice(0, separator),
      context.appRoot,
      path,
    );
    if (target instanceof LandofileValidationError) return target;
    const mount = normalizeTmpfs(
      { target, readOnly: false, options: separator === -1 ? "" : entry.slice(separator + 1) },
      context,
      path,
    );
    if (mount instanceof LandofileValidationError) return mount;
    const error = add(mount, path);
    if (error !== undefined) return error;
  }
  return [
    ...[...compose.values()].filter((mount) => !lando.has(mount.target)),
    ...[...lando.values()].map(({ mount }) => mount),
  ];
};
