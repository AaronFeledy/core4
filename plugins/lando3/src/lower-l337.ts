import { posix } from "node:path";
import { serviceCursor } from "./claims.ts";
import type { LoweringPatch, ServiceLoweringContext, V4Wire } from "./lowering-contract.ts";
import { hasPlainObjectPrototype } from "./lowering-contract.ts";

export const lowerL337 = (
  service: V4Wire,
  lowered: LoweringPatch,
  ctx: ServiceLoweringContext,
): LoweringPatch => {
  const cursor = serviceCursor(service, ctx);
  const diagnostics = [...lowered.diagnostics];
  for (const key of ["appMount", "appmount", "app-mount"]) {
    if (Object.hasOwn(service, key))
      diagnostics.push(
        cursor.dropTree(
          [key],
          "Bare Lando 3 l337 services inferred the app mount only from volumes, not this Lando service option.",
          "Bind the app root under volumes, or configure appMount explicitly in Lando 4.",
        ),
      );
  }
  const volumes = Array.isArray(service.volumes) ? service.volumes : [];
  if (service.volumes !== undefined && !Array.isArray(service.volumes))
    diagnostics.push(
      cursor.dropTree(
        ["volumes"],
        "Lando 3 l337 volumes require a list of mount entries; this mapping was omitted.",
        "Configure each intended volume as an explicit Lando 4 mount list entry.",
      ),
    );
  let appMount: unknown = false;
  const appIndex = volumes.findLastIndex((volume: unknown) => {
    const source =
      typeof volume === "string"
        ? volume.split(":")[0]
        : hasPlainObjectPrototype(volume) && volume.type === "bind" && typeof volume.target === "string"
          ? volume.source
          : undefined;
    return (
      typeof source === "string" && source.length > 0 && posix.normalize(source).replace(/\/$/, "") === "."
    );
  });
  const kept = volumes.filter((volume: unknown, index) => {
    if (index !== appIndex) return true;
    const [, target, mode] =
      typeof volume === "string"
        ? volume.split(":")
        : hasPlainObjectPrototype(volume)
          ? [undefined, volume.target, volume.read_only === true ? "ro" : undefined]
          : [];
    if (target === undefined) return true;
    appMount = { target, ...(mode === "ro" ? { readOnly: true } : {}) };
    return false;
  });
  const differences = ["mounts", "storage"].filter(
    (key) => Array.isArray(lowered.patch[key]) && lowered.patch[key].length > 0,
  );
  if (lowered.patch.certs) differences.push("certs");
  const security = lowered.patch.security;
  if (hasPlainObjectPrototype(security) && Array.isArray(security.ca) && security.ca.length > 0)
    differences.push("security.ca");
  if (differences.length > 0)
    diagnostics.push(
      cursor.reviewTree(
        ["type"],
        `The converted Compose service applies ${differences.join(", ")}; bare Lando 3 l337 did not apply these Lando service settings.`,
        "Review these explicit settings and remove any behavior that was not intended.",
      ),
    );
  const { volumes: _volumes, ...patch } = lowered.patch;
  return {
    ...lowered,
    diagnostics,
    claims: cursor.claims,
    patch: { ...patch, type: "compose", appMount, ...(kept.length > 0 ? { volumes: kept } : {}) },
  };
};
