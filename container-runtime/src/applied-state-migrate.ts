import {
  AppPlan,
  type AppPlan as AppPlanShape,
  type MountPlan,
  PortablePath,
  duplicateMountTarget,
  orderMounts,
} from "@lando/sdk/schema";
import { Option, Predicate, Schema } from "effect";

/** Durable applied-plan frame version after the one-mount-list shape. */
export const APPLIED_STATE_VERSION = 2;

const APP_MOUNT_KEY = "app-mount";

const optionalStringArray = (value: unknown): readonly string[] | undefined | null => {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) return null;
  return value;
};

const optionalBoolean = (value: unknown): boolean | undefined | null => {
  if (value === undefined) return undefined;
  return typeof value === "boolean" ? value : null;
};

/**
 * Convert one v1 service (`appMount` + `mounts` + `storage`) into the v2 one-list
 * shape. Returns null when any entry cannot be represented without guessing.
 */
const migrateV1Service = (service: unknown): Record<string, unknown> | null => {
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
        const create = optionalBoolean(createHostPath);
        const excludes = optionalStringArray(mount.excludes);
        const includes = optionalStringArray(mount.includes);
        if (create === null || excludes === null || includes === null) return null;
        converted.push({
          type: "bind",
          source,
          target: portableTarget,
          readOnly,
          realization,
          ...(create === undefined ? {} : { createHostPath: create }),
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

  if (duplicateMountTarget(converted) !== undefined) return null;
  return { ...rest, mounts: orderMounts(converted) };
};

const migrateV1PlanRaw = (raw: unknown): unknown | null => {
  if (!Predicate.isObject(raw)) return null;
  const { services, ...rest } = raw;
  if (!Predicate.isObject(services)) return null;
  const nextServices: Record<string, unknown> = {};
  for (const [name, service] of Object.entries(services)) {
    const migrated = migrateV1Service(service);
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
  if (fromVersion !== 1) return null;
  const transformed = migrateV1PlanRaw(raw);
  if (transformed === null) return null;
  return Option.getOrNull(Schema.decodeUnknownOption(AppPlan)(transformed));
};

/**
 * Record-layout migrator: every entry must convert or the whole collection is null.
 */
export const migrateAppliedPlansRecord = (
  raw: unknown,
  fromVersion: number,
): Readonly<Record<string, AppPlanShape>> | null => {
  if (fromVersion !== 1) return null;
  if (!Predicate.isObject(raw)) return null;
  const next: Record<string, AppPlanShape> = {};
  for (const [id, plan] of Object.entries(raw)) {
    const migrated = migrateAppliedPlan(plan, 1);
    if (migrated === null) return null;
    next[id] = migrated;
  }
  return next;
};
