import { resolveCatalogType } from "./catalog.ts";
import type { Lando3TranslatorPorts } from "./contract.ts";
import type { TopLevelResult } from "./lower-top-level.ts";
import { type V4Wire, asStringArray, hasPlainObjectPrototype } from "./lowering-contract.ts";

export const lowerCatalogAppMountMasks = (
  patch: V4Wire,
  top: TopLevelResult,
  serviceFacts: Lando3TranslatorPorts["serviceFacts"],
): V4Wire => {
  if (patch.appMount === false || typeof patch.type !== "string") return patch;
  const resolution = resolveCatalogType(patch.type, serviceFacts);
  const target = serviceFacts[resolution.id]?.appMountTarget;
  if (resolution._tag === "unknown-type" || target === undefined) return patch;
  if (top.appMountExcludes.length === 0 && top.appMountIncludes.length === 0) return patch;
  const app = hasPlainObjectPrototype(patch.appMount) ? patch.appMount : {};
  return {
    ...patch,
    appMount: {
      target,
      ...app,
      excludes: [...new Set([...top.appMountExcludes, ...(asStringArray(app.excludes) ?? [])])],
      includes: [...new Set([...top.appMountIncludes, ...(asStringArray(app.includes) ?? [])])],
    },
  };
};
