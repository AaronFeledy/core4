import { posix } from "node:path";
import type { ConfigTranslateDiagnostic } from "@lando/sdk/schema";
import { serviceCursor } from "./claims.ts";
import type { Lando3Path } from "./contract.ts";
import {
  type LoweringPatch,
  type MountFilterLocation,
  type ServiceLoweringContext,
  type V4Wire,
  asStringArray,
} from "./lowering-contract.ts";
import { droppedServiceKey, needsReviewServiceKey, rewrittenServiceKey } from "./service-diagnostics.ts";

export const lowerApi4MountFilters = (
  item: V4Wire,
  ctx: ServiceLoweringContext,
  mount: {
    readonly relative: Lando3Path;
    readonly target: string;
    readonly source: unknown;
    readonly app: boolean;
  },
): LoweringPatch => {
  const cursor = serviceCursor(item, ctx, mount.relative);
  for (const key of ["read_only", "readOnly", "exclude", "excludes", "include", "includes"])
    cursor.mapTo([...mount.relative, key]);
  const patch: Record<string, unknown> = {};
  const diagnostics: ConfigTranslateDiagnostic[] = [];
  for (const key of [
    "read_only",
    "exclude",
    "excludes",
    ...(item.type === "copy" ? ["include", "includes"] : []),
  ]) {
    if (
      !Object.hasOwn(item, key) ||
      (key === "read_only" ? typeof item[key] === "boolean" : asStringArray(item[key]) !== undefined)
    )
      continue;
    diagnostics.push(
      droppedServiceKey({
        ctx,
        relative: [...mount.relative, key],
        message: `Lando 3 could not normalize this ${key} value into mount settings.`,
        remediation:
          key === "read_only"
            ? "Set readOnly to a boolean in Lando 4."
            : "Use a path string or list of path strings on the converted mount.",
      }),
    );
  }
  if (typeof item.read_only === "boolean") patch.readOnly = item.read_only;
  if (Object.hasOwn(item, "readOnly"))
    diagnostics.push(
      droppedServiceKey({
        ctx,
        relative: [...mount.relative, "readOnly"],
        message: "Lando 3 passed readOnly to Compose, which accepts only read_only, so it never applied.",
        remediation: "Set readOnly: true on the converted mount if it should be read-only.",
      }),
    );
  const excludes = [
    ...(mount.app ? ctx.topLevel.excludes : []),
    ...(asStringArray(item.exclude) ?? []),
    ...(asStringArray(item.excludes) ?? []),
  ];
  const includes: string[] = [];
  const include = (value: string, relative: Lando3Path, location?: MountFilterLocation): void => {
    const path = value.replace(/^\//, "");
    if (
      path.length === 0 ||
      /[*?[]/.test(path) ||
      /^[\\/]|^[a-z]:[\\/]/i.test(path) ||
      path.split(/[\\/]/).includes("..")
    ) {
      diagnostics.push(
        droppedServiceKey({
          ctx:
            location === undefined ? ctx : { ...ctx, keyPath: [], occurrenceAt: () => location.occurrence },
          relative: location?.keyPath ?? relative,
          message:
            path.length === 0
              ? "This include names no path, so it was omitted."
              : "Lando 3 re-bound this include as a literal host path; Lando 4 accepts only literal relative paths without globs or .. segments.",
          remediation:
            "Replace this include with a literal path inside the app root, or configure the intended mount explicitly.",
        }),
      );
      return;
    }
    includes.push(path);
  };
  if (mount.app) {
    ctx.topLevel.includes.forEach((value, index) =>
      include(value, mount.relative, ctx.topLevel.includeLocations?.[index]),
    );
    for (const value of ctx.topLevel.excludes)
      if (value.startsWith("!")) include(value.slice(1), mount.relative);
  }
  for (const key of ["exclude", "excludes"]) {
    (asStringArray(item[key]) ?? []).forEach((value, index) => {
      if (value.startsWith("!"))
        include(value.slice(1), [...mount.relative, key, ...(Array.isArray(item[key]) ? [index] : [])]);
    });
  }
  for (const key of ["include", "includes"]) {
    if (item.type === "copy")
      (asStringArray(item[key]) ?? []).forEach((value, index) =>
        include(value, [...mount.relative, key, ...(Array.isArray(item[key]) ? [index] : [])]),
      );
    else if (Object.hasOwn(item, key))
      diagnostics.push(
        droppedServiceKey({
          ctx,
          relative: [...mount.relative, key],
          message: "Lando 3 applied includes only to copy mounts.",
          remediation: "Set includes on the converted mount by hand if needed.",
        }),
      );
  }
  const masked = excludes.filter((value) => !value.startsWith("!")).map((value) => value.replace(/^\//, ""));
  if (masked.length > 0) patch.excludes = masked;
  const appRoot = mount.app || mount.source === "." || mount.source === "./" || mount.source === "";
  if (includes.length > 0) {
    if (appRoot && item.read_only !== true) {
      patch.includes = includes;
      if (item.type === "copy")
        diagnostics.push(
          needsReviewServiceKey({
            ctx,
            relative: mount.relative,
            message: `The converted bind already exposes ${includes.join(", ")} live.`,
            remediation: "Keep the live bind or recreate image COPY behavior in a build step.",
          }),
        );
    } else {
      patch.mounts = includes.map((path) => ({
        source: `./${path}`,
        target: posix.join(mount.target, path),
      }));
      diagnostics.push(
        rewrittenServiceKey({
          ctx,
          relative: mount.relative,
          message: "Recreated Lando 3 app-root-relative include paths as explicit read-write child binds.",
          remediation:
            "Review the child binds; Lando 3 rebound these paths from the app root, not the parent mount source.",
        }),
      );
    }
  }
  return { patch, claims: cursor.claims, diagnostics };
};
