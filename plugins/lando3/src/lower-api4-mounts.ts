import { isLegacyTagged } from "@lando/sdk/landofile";
import type { ConfigTranslateDiagnostic } from "@lando/sdk/schema";
import { serviceCursor } from "./claims.ts";
import type { Lando3Path } from "./contract.ts";
import {
  lowerApi4AppMount,
  lowerApi4MountString,
  lowerApi4StorageFields,
  mountOwnershipDiagnostics,
  mountOwnershipKeys,
  mountSourceKeys,
  mountTagDiagnostics,
  mountTargetKeys,
} from "./lower-api4-mount-fields.ts";
import { lowerApi4MountFilters } from "./lower-api4-mount-filters.ts";
import type { LoweringPatch, ServiceLoweringContext, V4Wire } from "./lowering-contract.ts";
import { hasPlainObjectPrototype } from "./lowering-contract.ts";
import {
  droppedServiceKey,
  needsReviewServiceKey,
  rewrittenServiceKey,
  unsupportedServiceKey,
} from "./service-diagnostics.ts";

/** Normalize Lando 3 API-4 mounts, retaining a disposition for every authored field. */
export const lowerApi4Mounts = (service: V4Wire, ctx: ServiceLoweringContext): LoweringPatch => {
  const cursor = serviceCursor(service, ctx);
  // Mutable output accumulators never change the authored input.
  const patch: Record<string, unknown> = {};
  const mounts: V4Wire[] = [];
  const storage: V4Wire[] = [];
  const diagnostics: ConfigTranslateDiagnostic[] = [];
  let blocked = false;
  const report = (relative: Lando3Path, message: string, remediation: string, emit = droppedServiceKey) => {
    cursor.acceptNoOp(relative);
    diagnostics.push(emit({ ctx, relative, message, remediation }));
  };
  const short = (text: string, relative: Lando3Path): V4Wire | undefined => {
    cursor.take(relative);
    const result = lowerApi4MountString(text, ctx, relative);
    diagnostics.push(...result.diagnostics);
    return Object.hasOwn(result.patch, "target") ? result.patch : undefined;
  };
  const object = (item: V4Wire, relative: Lando3Path, role: "app" | "bind" | "storage"): void => {
    const type = item.type;
    if (role === "bind" && typeof type === "string" && type.startsWith("storage")) {
      object({ ...item, type: type.split(":")[1] ?? "volume" }, relative, "storage");
      return;
    }
    if (role === "storage" && type === "bind") {
      object(item, relative, "bind");
      return;
    }
    if (
      (role === "bind" && type !== undefined && type !== "bind" && type !== "copy") ||
      (role === "storage" && type !== undefined && type !== "volume")
    ) {
      diagnostics.push(...mountOwnershipDiagnostics(item, ctx, relative));
      report(
        relative,
        `Lando 3 ignored mounts of type ${String(type)}; no mount was emitted.`,
        "Remove this ignored entry, or declare a host bind under mounts or a volume under storage in Lando 4.",
      );
      return;
    }
    const tags = mountTagDiagnostics(item, ctx, relative);
    if (tags.length > 0) {
      cursor.acceptNoOp(relative);
      diagnostics.push(...tags);
      blocked = true;
      return;
    }
    const hasTarget =
      role === "storage" ? item.target != null : typeof item.target === "string" && item.target.length > 0;
    let targetKey = "target";
    if (!hasTarget) targetKey = item.destination != null ? "destination" : "dest";
    const target = item[targetKey];
    const sourceKey = item.source || item.src === undefined ? "source" : "src";
    const source = item[sourceKey];
    if (typeof target !== "string" || target.length === 0) {
      report(
        relative,
        role === "app"
          ? "App mount object needs a target; Lando 3 could not mount it."
          : "Lando 3 could not mount this entry without a target.",
        "Set target to the intended container path on the converted mount.",
        role === "app" ? unsupportedServiceKey : droppedServiceKey,
      );
      return;
    }
    if (role === "bind" && typeof source !== "string") {
      for (const key of ["content", "contents"])
        if (Object.hasOwn(item, key))
          report(
            [...relative, key],
            "Lando 3 created a literal file here; Lando 4 needs an explicit image build step instead.",
            "Create this file with its authored content in an image build step.",
          );
      report(
        relative,
        "This entry has no bind source; recreate the Lando 3 literal file in an image build step or supply a host source.",
        "Set source to a host path, or create the file in an image build step and remove this mount.",
      );
      return;
    }
    if (role === "storage" && item.scope === "global") {
      cursor.acceptNoOp(relative);
      report(
        [...relative, "scope"],
        "Lando 4 does not support global data storage yet",
        "Use scope: app to keep the data per app, or keep this app on Lando 3.",
        unsupportedServiceKey,
      );
      return;
    }
    const remaining = new Set(Object.keys(item));
    cursor.take(relative);
    cursor.take([...relative, targetKey]);
    cursor.take([...relative, "type"]);
    for (const key of mountTargetKeys) {
      remaining.delete(key);
      if (key !== targetKey && Object.hasOwn(item, key))
        report(
          [...relative, key],
          `Lando 3 used ${targetKey} and ignored this target alias.`,
          "Keep target on the converted mount and remove the unused alias.",
        );
    }
    remaining.delete("type");
    if ((role === "app" && type !== undefined && type !== "bind") || (role === "bind" && type === "copy"))
      report(
        relative,
        `Converted the Lando 3 ${String(type)} ${role === "app" ? "app mount" : "mount"} to a live bind; Lando 4 does not copy mounted files into the image.`,
        "Keep the live bind, or recreate image COPY behavior in an image build step.",
        needsReviewServiceKey,
      );
    for (const key of mountSourceKeys) {
      cursor.take([...relative, key]);
      remaining.delete(key);
      if (!Object.hasOwn(item, key)) continue;
      if (role === "app")
        report(
          [...relative, key],
          "Lando 3 always mounted the app root here and ignored source.",
          `To mount another host directory at ${target}, add a mounts: entry for it.`,
        );
      else if (role === "storage" && key === "source" && !item[key]) cursor.acceptNoOp([...relative, key]);
      else if (key !== (role === "storage" ? "source" : sourceKey) || typeof item[key] !== "string")
        report(
          [...relative, key],
          "Lando 3 ignored this source alias; use source on the converted mount.",
          "Keep source for a host bind or store for a storage volume; remove the ignored alias.",
        );
    }
    for (const key of mountOwnershipKeys) {
      remaining.delete(key);
      cursor.mapTo([...relative, key]);
    }
    diagnostics.push(...mountOwnershipDiagnostics(item, ctx, relative));
    const output: Record<string, unknown> = { ...(role === "bind" ? { source } : {}), target };
    switch (role) {
      case "storage": {
        remaining.delete("scope");
        cursor.take([...relative, "scope"]);
        const fields = lowerApi4StorageFields({ ...item, target }, ctx, relative);
        Object.assign(output, fields.patch);
        diagnostics.push(...fields.diagnostics);
        storage.push(output);
        break;
      }
      case "app":
      case "bind": {
        for (const key of ["read_only", "readOnly", "exclude", "excludes", "include", "includes"]) {
          remaining.delete(key);
          cursor.mapTo([...relative, key]);
        }
        const filters = lowerApi4MountFilters(item, ctx, { relative, target, source, app: role === "app" });
        const { mounts: children, ...fields } = filters.patch;
        Object.assign(output, fields);
        if (role === "app") patch.appMount = output;
        else mounts.push(output);
        if (Array.isArray(children)) mounts.push(...children);
        diagnostics.push(...filters.diagnostics);
        break;
      }
      default:
        role satisfies never;
    }
    for (const key of remaining)
      report(
        [...relative, key],
        "This Lando 3 field has no equivalent on this Lando 4 mount; configure the intended behavior explicitly.",
        "Remove this field from the mount and configure its intended behavior separately in Lando 4.",
      );
  };
  const app = lowerApi4AppMount(service, ctx);
  for (const key of ["appMount", "appmount", "app-mount"]) {
    cursor.take([key]);
    if (key !== app.relative[0]) cursor.acceptNoOp([key]);
  }
  diagnostics.push(...app.diagnostics);
  if (app.mount === false) patch.appMount = false;
  else if (app.mount !== undefined) object(app.mount, app.relative, "app");
  for (const key of ["mounts", "mount", "storage", "persistent-storage"]) {
    cursor.take([key]);
    if (key === "persistent-storage" && Object.hasOwn(service, key))
      report(
        [key],
        "Rewrote Lando 3 persistent-storage as Lando 4 storage.",
        "Keep the converted entries under storage; remove the persistent-storage alias.",
        rewrittenServiceKey,
      );
    const entries = service[key];
    if (!Array.isArray(entries)) continue;
    entries.forEach((item: unknown, index) => {
      const relative = [key, index];
      if (isLegacyTagged(item)) {
        report(
          relative,
          "Tagged mounts need an explicit path; referenced files are never read during conversion.",
          "Replace the tagged reference with an explicit mount source and target.",
          unsupportedServiceKey,
        );
        blocked = true;
      } else if (hasPlainObjectPrototype(item))
        object(item, relative, key === "mounts" || key === "mount" ? "bind" : "storage");
      else if (typeof item === "string") {
        if ((key === "storage" || key === "persistent-storage") && !item.includes(":"))
          object({ target: item }, relative, "storage");
        else {
          const mount = short(item, relative);
          if (mount !== undefined) mounts.push(mount);
        }
      } else
        report(
          relative,
          "Lando 3 could not normalize this mount; supply a source and target in Lando 4.",
          "Use a source:target string or a mount object with explicit source and target paths.",
        );
    });
  }
  if (mounts.length > 0) patch.mounts = mounts;
  if (storage.length > 0) patch.storage = storage;
  return { patch, claims: cursor.claims, diagnostics, ...(blocked ? { blocked: true as const } : {}) };
};
