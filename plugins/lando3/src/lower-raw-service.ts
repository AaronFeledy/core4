import { serviceCursor } from "./claims.ts";
import { lowerCatalogCommon } from "./lower-catalog-common.ts";
import { lowerHealthcheck } from "./lower-healthcheck.ts";
import {
  type LoweringPatch,
  type ServiceLoweringContext,
  type V4Wire,
  hasPlainObjectPrototype,
  mergePatches,
} from "./lowering-contract.ts";
import { rewrittenMeUser } from "./service-diagnostics.ts";

export const lowerRawService = (
  service: V4Wire,
  ctx: ServiceLoweringContext,
  nested: LoweringPatch,
): LoweringPatch => {
  const cursor = serviceCursor(service, ctx);
  const { config: _config, meUser: _meUser, ...commonFields } = service;
  const common = lowerCatalogCommon(commonFields, { ...ctx, cursor });
  const diagnostics: LoweringPatch["diagnostics"][number][] = [];
  const patch: Record<string, unknown> = { type: "compose" };
  if (typeof service.meUser === "string") {
    cursor.take(["meUser"]);
    patch.user = service.meUser;
    diagnostics.push(rewrittenMeUser({ ctx }));
  }
  cursor.take(["config"]);
  for (const key of Object.keys(hasPlainObjectPrototype(service.config) ? service.config : {})) {
    diagnostics.push(
      cursor.rejectTree(
        ["config", key],
        "Raw inline file contents have no Lando 4 target.",
        "Create the file yourself and configure an explicit mount; conversion does not read referenced files.",
      ),
    );
  }
  // Compose reads a null named volume or network as one with default settings.
  const topLevel = Object.fromEntries(
    ["volumes", "networks"].flatMap((key) => {
      const entries = cursor.mapTo([key]);
      return hasPlainObjectPrototype(entries)
        ? [[key, Object.fromEntries(Object.entries(entries).map(([name, config]) => [name, config ?? {}]))]]
        : [];
    }),
  );
  return mergePatches(common, nested, lowerHealthcheck(service, { ...ctx, cursor }), {
    patch,
    topLevel,
    diagnostics,
    claims: cursor.claims,
  });
};
