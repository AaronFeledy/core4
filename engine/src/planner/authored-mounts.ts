import { posix, win32 } from "node:path";
import { LandofileValidationError } from "@lando/sdk/errors";
import type { MountPlan, ServiceConfig, ValidationIssuePath } from "@lando/sdk/schema";
import { landoServiceStorageName } from "@lando/sdk/schema";
import { compileConfigMounts } from "./authored-config-mounts.ts";
import {
  type CompiledAuthoredMount,
  type MountAuthoringContext,
  classifyMount,
  mountInputError,
  normalizeTmpfs,
} from "./authored-mount-entry.ts";
import type { AuthoredStorageInfo } from "./service-types.ts";
import { cacheStorageKey, cacheStoreName, plannedContainerDestination } from "./storage.ts";

export interface CompiledAuthoredMounts {
  readonly mounts: readonly MountPlan[];
  readonly storageByTarget: ReadonlyMap<string, AuthoredStorageInfo>;
}

/** Includes are literal relative paths: exact ones cancel an exclude, nested ones reopen a shadowed path. */
export const literalIncludeError = (
  context: MountAuthoringContext,
  include: string,
  path: ValidationIssuePath,
): LandofileValidationError | undefined =>
  posix.isAbsolute(include) ||
  win32.isAbsolute(include) ||
  include.split(/[\\/]/u).includes("..") ||
  /[*?[]/u.test(include) ||
  include.startsWith("!")
    ? mountInputError(
        context,
        [path],
        `Mount include ${include} must be a literal relative path.`,
        "Use a relative path without .., absolute paths, ! prefixes, or glob characters; exact includes cancel excludes and nested includes reopen a shadowed directory.",
      )
    : undefined;

/** An exclude names a path strictly beneath its bind; anything else would shadow outside the mount. */
export const excludeDestination = (
  context: MountAuthoringContext,
  bindTarget: string,
  exclude: string,
  path: ValidationIssuePath,
): MountPlan["target"] | LandofileValidationError => {
  const prefix = `${bindTarget.replace(/\/+$/u, "")}/`;
  const target = plannedContainerDestination(posix.join(prefix, exclude), context.appRoot, path);
  if (target instanceof LandofileValidationError) return target;
  return target.startsWith(prefix)
    ? target
    : mountInputError(
        context,
        [path],
        `Mount exclude ${exclude} resolves outside ${bindTarget}.`,
        "Use a relative path beneath the mount, without .. segments that leave it.",
      );
};

export const compileAuthoredMounts = (
  context: MountAuthoringContext,
  normalized: ServiceConfig,
  storage: ServiceConfig["storage"],
): CompiledAuthoredMounts | LandofileValidationError => {
  const lando = new Map<string, CompiledAuthoredMount & { readonly path: ValidationIssuePath }>();
  const compose = new Map<string, CompiledAuthoredMount & { readonly path: ValidationIssuePath }>();
  // Lando spellings (mounts, storage, tmpfs) outrank the Compose tier (volumes, configs).
  const add = (
    compiled: CompiledAuthoredMount,
    path: ValidationIssuePath,
    spelling: "lando" | "compose" = "lando",
  ): LandofileValidationError | undefined => {
    const { mount } = compiled;
    const tier = spelling === "compose" ? compose : lando;
    const previous = tier.get(mount.target);
    if (previous !== undefined)
      return mountInputError(
        context,
        [previous.path, path],
        `Multiple ${tier === compose ? "Compose" : "Lando"} mounts claim ${mount.target}.`,
        tier === compose
          ? "Keep only one volumes or configs entry at this destination."
          : "Keep only one mounts, storage, or tmpfs entry at this destination.",
      );
    tier.set(mount.target, { ...compiled, path });
  };
  for (const [index, entry] of (storage ?? []).entries()) {
    const path = ["services", context.serviceName, "storage", index];
    const target = plannedContainerDestination(
      typeof entry === "string" ? entry : entry.target,
      context.appRoot,
      path,
    );
    if (target instanceof LandofileValidationError) return target;
    let store: string;
    if (typeof entry === "string")
      store = landoServiceStorageName(context.appSlug, context.storeOwner ?? context.serviceName, target);
    else store = entry.kind === "cache" ? cacheStoreName(target, entry.key) : entry.store;
    const error = add(
      {
        mount: {
          type: "volume",
          origin: "authored",
          store,
          target,
          readOnly: typeof entry === "string" ? false : (entry.readOnly ?? false),
        },
        storage: {
          scope:
            typeof entry === "string"
              ? "service"
              : entry.kind === "cache"
                ? "global"
                : (entry.scope ?? "service"),
          kind: typeof entry === "string" ? "data" : (entry.kind ?? "data"),
          ...(typeof entry !== "string" && entry.kind === "cache"
            ? { key: cacheStorageKey(target, entry.key) }
            : typeof entry !== "string" && entry.key !== undefined
              ? { key: entry.key }
              : {}),
        },
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
      const error = add(mount, path, key === "volumes" ? "compose" : "lando");
      if (error !== undefined) return error;
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
    const error = add({ mount }, path);
    if (error !== undefined) return error;
  }
  const configs = compileConfigMounts(context, normalized.configs);
  if (configs instanceof LandofileValidationError) return configs;
  for (const { mount, path } of configs) {
    const error = add({ mount }, path, "compose");
    if (error !== undefined) return error;
  }
  const selected = [
    ...[...compose.values()].filter(({ mount }) => !lando.has(mount.target)),
    ...lando.values(),
  ];
  const stores = new Map<string, AuthoredStorageInfo>();
  const storageByTarget = new Map<string, AuthoredStorageInfo>();
  for (const { mount, storage } of selected) {
    if (mount.type !== "volume" || storage === undefined) continue;
    const previous = stores.get(mount.store);
    if (
      previous !== undefined &&
      (previous.scope !== storage.scope || previous.kind !== storage.kind || previous.key !== storage.key)
    )
      return mountInputError(
        context,
        [["services", context.serviceName]],
        `Store ${mount.store} has conflicting definitions in service ${context.serviceName}.`,
        "Use the same scope, kind, and key for each definition of a shared store.",
      );
    stores.set(mount.store, storage);
    storageByTarget.set(mount.target, storage);
  }
  return { mounts: selected.map(({ mount }) => mount), storageByTarget };
};

/**
 * Checks that need only authored input, shared by `app:config:lint` and
 * planning: duplicate Lando destinations, mount syntax, tmpfs access modes,
 * bind-only excludes, and literal includes.
 */
export const validateAuthoredMounts = (
  context: MountAuthoringContext,
  normalized: ServiceConfig,
  storage: ServiceConfig["storage"],
  appMount: ServiceConfig["appMount"],
): LandofileValidationError | undefined => {
  const compiled = compileAuthoredMounts(context, normalized, storage);
  if (compiled instanceof LandofileValidationError) return compiled;
  const binds: Array<{
    readonly target: string;
    readonly excludes: readonly string[];
    readonly includes: readonly string[];
    readonly path: ValidationIssuePath;
  }> = [];
  if (typeof appMount === "object")
    binds.push({
      target: appMount.target,
      excludes: appMount.excludes ?? [],
      includes: appMount.includes ?? [],
      path: ["services", context.serviceName, "appMount"],
    });
  for (const [index, entry] of (normalized.mounts ?? []).entries())
    if (typeof entry === "object")
      binds.push({
        target: entry.target,
        excludes: entry.excludes ?? [],
        includes: entry.includes ?? [],
        path: ["services", context.serviceName, "mounts", index],
      });
  for (const bind of binds) {
    for (const exclude of bind.excludes) {
      const target = excludeDestination(context, bind.target, exclude, [...bind.path, "excludes"]);
      if (target instanceof LandofileValidationError) return target;
    }
    for (const include of bind.includes) {
      const error = literalIncludeError(context, include, [...bind.path, "includes"]);
      if (error !== undefined) return error;
    }
  }
  return undefined;
};
