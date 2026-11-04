import { isAbsolute, resolve, win32 } from "node:path";
import {
  AppPlan,
  type AppPlan as AppPlanShape,
  type MountPlan,
  PortablePath,
  duplicateMountTarget,
  orderMounts,
} from "@lando/sdk/schema";
import { Option, Predicate, Schema } from "effect";
import { migrateAppliedInit } from "./applied-init-migrate.ts";

/** Durable applied-plan frame version with canonical mounts and native init intent. */
export const APPLIED_STATE_VERSION = 3;

const APP_MOUNT_KEY = "app-mount";

const optionalStringArray = (value: unknown): readonly string[] | undefined | null => {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) return null;
  return value;
};

/** v1 kept service `tmpfs:` as a Compose runtime knob: strings `target[:options]` or long objects. */
const legacyComposeTmpfs = (entry: unknown): MountPlan | null => {
  let target: unknown;
  let tokens: string[];
  if (typeof entry === "string") {
    const separator = entry.indexOf(":");
    target = separator === -1 ? entry : entry.slice(0, separator);
    tokens =
      separator === -1
        ? []
        : entry
            .slice(separator + 1)
            .split(",")
            .filter((token) => token.length > 0);
  } else if (Predicate.isObject(entry)) {
    const { size, mode, read_only: readOnly } = entry;
    if (size !== undefined && typeof size !== "string" && typeof size !== "number") return null;
    if (mode !== undefined && (typeof mode !== "number" || !Number.isSafeInteger(mode))) return null;
    if (readOnly !== undefined && typeof readOnly !== "boolean") return null;
    target = entry.target;
    tokens = [
      ...(readOnly === true ? ["ro"] : []),
      ...(size === undefined ? [] : [`size=${size}`]),
      ...(mode === undefined ? [] : [`mode=${mode.toString(8)}`]),
    ];
  } else {
    return null;
  }
  if (typeof target !== "string" || (tokens.includes("ro") && tokens.includes("rw"))) return null;
  const options = tokens.filter((token) => token !== "ro" && token !== "rw").join(",");
  return {
    type: "tmpfs",
    target: PortablePath.make(target),
    readOnly: tokens.includes("ro"),
    ...(options.length === 0 ? {} : { options }),
  };
};

/**
 * Convert one v1 service (`appMount` + `mounts` + `storage`) into the v2 one-list
 * shape. Returns null when any entry cannot be represented without guessing.
 */
interface V1Project {
  readonly root: string;
  readonly configs: Readonly<Record<string, unknown>>;
}

/** v1 rendered Compose config grants from extensions; v2 carries them as read-only binds. */
const legacyConfigGrant = (grant: unknown, project: V1Project): MountPlan | null => {
  if (!Predicate.isObject(grant) || typeof grant.source !== "string" || grant.source.length === 0)
    return null;
  const definition = project.configs[grant.source];
  const file = Predicate.isObject(definition) ? definition.file : undefined;
  if (typeof file !== "string" || file.length === 0) return null;
  const target = grant.target === undefined ? `/${grant.source}` : grant.target;
  if (typeof target !== "string" || target.length === 0) return null;
  const mode = grant.mode;
  const fileMode = typeof mode === "string" && /^[0-7]+$/u.test(mode) ? Number.parseInt(mode, 8) : mode;
  if (fileMode !== undefined && (typeof fileMode !== "number" || !Number.isInteger(fileMode))) return null;
  const windowsRoot = /^[A-Za-z]:[\\/]/u.test(project.root) || project.root.startsWith("\\\\");
  const source =
    isAbsolute(file) || win32.isAbsolute(file)
      ? file
      : windowsRoot
        ? win32.resolve(project.root, file)
        : resolve(project.root, file);
  return {
    type: "bind",
    source,
    target: PortablePath.make(target),
    readOnly: true,
    createHostPath: false,
    realization: "passthrough",
    ...(fileMode === undefined ? {} : { fileMode }),
  };
};

const migrateV1Service = (service: unknown, project: V1Project): Record<string, unknown> | null => {
  if (!Predicate.isObject(service)) return null;
  const { appMount, mounts: legacyMounts, storage, ...rest } = service;
  const converted: MountPlan[] = [];

  if (appMount !== undefined) {
    if (!Predicate.isObject(appMount)) return null;
    const { source, target, readOnly, realization, excludes, includes } = appMount;
    if (typeof source !== "string" || typeof target !== "string" || typeof readOnly !== "boolean") {
      return null;
    }
    if (realization !== "passthrough" && realization !== "accelerated") return null;
    const excludeList = optionalStringArray(excludes);
    const includeList = optionalStringArray(includes);
    if (excludeList === null || includeList === null) return null;
    converted.push({
      type: "bind",
      source,
      target: PortablePath.make(target),
      readOnly,
      realization,
      role: "app",
      ...(excludeList === undefined ? {} : { excludes: [...excludeList] }),
      ...(includeList === undefined ? {} : { includes: [...includeList] }),
      ...(realization === "accelerated" ? { mountKey: APP_MOUNT_KEY } : {}),
    });
  }

  if (legacyMounts !== undefined) {
    if (!Array.isArray(legacyMounts)) return null;
    for (const mount of legacyMounts) {
      if (!Predicate.isObject(mount)) return null;
      const { type, target, readOnly } = mount;
      if (typeof target !== "string" || typeof readOnly !== "boolean") return null;
      const portableTarget = PortablePath.make(target);

      if (type === "bind") {
        const { source, realization, createHostPath } = mount;
        if (typeof source !== "string") return null;
        if (realization !== "passthrough" && realization !== "accelerated") return null;
        // Accelerated non-app binds used index-derived mountKeys; never invent one.
        if (realization === "accelerated") return null;
        if (createHostPath !== undefined && typeof createHostPath !== "boolean") return null;
        const excludes = optionalStringArray(mount.excludes);
        const includes = optionalStringArray(mount.includes);
        if (excludes === null || includes === null) return null;
        converted.push({
          type: "bind",
          source,
          target: portableTarget,
          readOnly,
          realization,
          ...(createHostPath === undefined ? {} : { createHostPath }),
          ...(excludes === undefined ? {} : { excludes }),
          ...(includes === undefined ? {} : { includes }),
        });
      } else if (type === "volume") {
        // Raw v1 volume mounts named the store in `source`.
        const { source, subpath } = mount;
        if (typeof source !== "string") return null;
        if (subpath !== undefined && typeof subpath !== "string") return null;
        converted.push({
          type: "volume",
          store: source,
          target: portableTarget,
          readOnly,
          ...(typeof subpath === "string" ? { subpath } : {}),
        });
      } else if (type === "tmpfs") {
        const { options } = mount;
        if (options !== undefined && typeof options !== "string") return null;
        converted.push({
          type: "tmpfs",
          target: portableTarget,
          readOnly,
          ...(typeof options === "string" ? { options } : {}),
        });
      } else {
        return null;
      }
    }
  }

  if (storage !== undefined) {
    if (!Array.isArray(storage)) return null;
    for (const entry of storage) {
      if (!Predicate.isObject(entry)) return null;
      const { store, target, readOnly, subpath } = entry;
      if (typeof store !== "string" || typeof target !== "string" || typeof readOnly !== "boolean") {
        return null;
      }
      if (subpath !== undefined && typeof subpath !== "string") return null;
      converted.push({
        type: "volume",
        store,
        target: PortablePath.make(target),
        readOnly,
        ...(typeof subpath === "string" ? { subpath } : {}),
      });
    }
  }

  let extensions = rest.extensions;
  if (
    Predicate.isObject(extensions) &&
    Predicate.isObject(extensions.compose) &&
    "tmpfs" in extensions.compose
  ) {
    const { tmpfs, ...compose } = extensions.compose;
    if (!Array.isArray(tmpfs)) return null;
    for (const entry of tmpfs) {
      const mount = legacyComposeTmpfs(entry);
      if (mount === null) return null;
      converted.push(mount);
    }
    extensions = { ...extensions, compose };
  }
  if (
    Predicate.isObject(extensions) &&
    Predicate.isObject(extensions.compose) &&
    "configs" in extensions.compose
  ) {
    const grants = extensions.compose.configs;
    if (!Array.isArray(grants)) return null;
    for (const grant of grants) {
      const mount = legacyConfigGrant(grant, project);
      if (mount === null) return null;
      converted.push(mount);
    }
  }

  if (duplicateMountTarget(converted) !== undefined) return null;
  return { ...rest, ...(extensions === undefined ? {} : { extensions }), mounts: orderMounts(converted) };
};

const migrateV1PlanRaw = (raw: unknown): unknown | null => {
  if (!Predicate.isObject(raw)) return null;
  const { services, ...rest } = raw;
  if (!Predicate.isObject(services) || typeof rest.root !== "string") return null;
  const compose = Predicate.isObject(rest.extensions) ? rest.extensions.compose : undefined;
  const configs = Predicate.isObject(compose) && Predicate.isObject(compose.configs) ? compose.configs : {};
  const project: V1Project = { root: rest.root, configs };
  const nextServices: Record<string, unknown> = {};
  for (const [name, service] of Object.entries(services)) {
    const migrated = migrateV1Service(service, project);
    if (migrated === null) return null;
    nextServices[name] = migrated;
  }
  return { ...rest, services: nextServices };
};

/**
 * State-store `onVersionMismatch` migrator for a single applied `AppPlan`.
 * Receives the raw frame payload and stamped version; returns a decoded plan or
 * null when the shape cannot be converted (bucket treats null as absent).
 */
export const migrateAppliedPlan = (raw: unknown, fromVersion: number): AppPlanShape | null => {
  if (fromVersion !== 1 && fromVersion !== 2) return null;
  const transformed = migrateAppliedInit(fromVersion === 1 ? migrateV1PlanRaw(raw) : raw);
  if (transformed === null) return null;
  return Option.getOrNull(Schema.decodeUnknownOption(AppPlan)(transformed));
};

/**
 * Record-layout migration is atomic: losing any app would erase its ownership claim.
 */
export const migrateAppliedPlansRecord = (
  raw: unknown,
  fromVersion: number,
): Readonly<Record<string, AppPlanShape>> | null => {
  if (fromVersion !== 1 && fromVersion !== 2) return null;
  if (!Predicate.isObject(raw) || Array.isArray(raw)) return null;
  const next: Record<string, AppPlanShape> = {};
  for (const [id, plan] of Object.entries(raw)) {
    const migrated = migrateAppliedPlan(plan, fromVersion);
    if (migrated === null) return null;
    next[id] = migrated;
  }
  return next;
};
