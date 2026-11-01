import type { CatalogEntry } from "./catalog.ts";
import { serviceCursor } from "./claims.ts";
import {
  type LoweringPatch,
  type ServiceLoweringContext,
  type V4Wire,
  hasPlainObjectPrototype,
} from "./lowering-contract.ts";
import { serviceConfigMount } from "./service-config-mount.ts";
import { rewrittenServiceKey } from "./service-diagnostics.ts";

export const lowerCatalogConfig = (
  service: V4Wire,
  catalog: { readonly id: string; readonly entry: CatalogEntry | undefined },
  ctx: ServiceLoweringContext,
): LoweringPatch => {
  const cursor = serviceCursor(service, ctx);
  const diagnostics: LoweringPatch["diagnostics"][number][] = [];
  const patch: Record<string, unknown> = {};
  const config: { server?: string; dir?: string } = {};
  const mounts: V4Wire[] = [];
  const companionMounts: V4Wire[] = [];
  const rewrite = (relative: readonly string[], message: string) =>
    diagnostics.push(
      rewrittenServiceKey({
        ctx,
        relative,
        message,
        remediation: "Review the generated service fields before starting the app.",
      }),
    );
  cursor.take(["config"]);
  if (hasPlainObjectPrototype(service.config))
    for (const [key, value] of Object.entries(service.config)) {
      const mounted = serviceConfigMount(catalog, key, service);
      const slot = catalog.entry?.configKeys?.[key];
      if (typeof value === "string" && mounted !== undefined) {
        cursor.take(["config", key]);
        const mount = { type: "bind", source: value, target: mounted.target, readOnly: true };
        (mounted.companion ? companionMounts : mounts).push(mount);
        rewrite(["config", key], `Mounted ${key} read-only at ${mounted.target}.`);
      } else if (typeof value === "string" && (slot === "server" || slot === "dir")) {
        cursor.take(["config", key]);
        config[slot] = value;
      } else {
        diagnostics.push(
          cursor.dropTree(
            ["config", key],
            mounted !== undefined || slot === "server" || slot === "dir"
              ? "Config slot requires a host path string."
              : `Config slot ${key} has no Lando 4 mapping for ${catalog.id}.`,
            "Configure the equivalent behavior by hand in the generated service if needed.",
          ),
        );
      }
    }
  if (mounts.length > 0) patch.mounts = mounts;
  if (Object.keys(config).length > 0) {
    patch.config = config;
    const destinations = Object.keys(config).flatMap((slot) => {
      const targets = ctx.serviceFacts[catalog.id]?.configTargets;
      const target = slot === "server" ? targets?.server : targets?.dir;
      return target === undefined ? [] : [target];
    });
    rewrite(
      ["config"],
      destinations.length === 0
        ? `Rewrote config slots to the ${catalog.id} service's file configuration.`
        : `Rewrote config slots to file configuration mounted at ${destinations.join(", ")}.`,
    );
  }
  return {
    patch,
    diagnostics,
    claims: cursor.claims,
    ...(companionMounts.length > 0
      ? { companions: { [`${ctx.serviceName}-nginx`]: { type: "nginx", mounts: companionMounts } } }
      : {}),
  };
};
