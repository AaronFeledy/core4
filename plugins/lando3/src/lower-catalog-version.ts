import type { ConfigTranslateDiagnostic } from "@lando/sdk/schema";
import type { CatalogResolution } from "./catalog.ts";
import type { ServiceLoweringContext } from "./lowering-contract.ts";
import {
  needsReviewServiceKey,
  rewrittenServiceKey,
  unsupportedServiceKey,
  unsupportedVersion,
} from "./service-diagnostics.ts";

const versionChoice = (id: string, supported: readonly string[]): string =>
  supported.length === 0
    ? `${id} publishes no versions; use its bare type or add an image.`
    : `Choose a supported ${id} version: ${supported.join(", ")}.`;

export const catalogVersionDiagnostics = (
  resolution: CatalogResolution,
  ctx: ServiceLoweringContext,
  supported: readonly string[],
): readonly ConfigTranslateDiagnostic[] => {
  const relative = ["type"];
  switch (resolution._tag) {
    case "unknown-type":
      return [];
    case "unsupported-version":
      return [
        resolution.lando3Default === undefined
          ? unsupportedVersion({ ctx, relative, ...resolution, type: resolution.id })
          : unsupportedServiceKey({
              ctx,
              relative,
              message: `No ${resolution.id} version was set, so Lando 3 used ${resolution.id} ${resolution.lando3Default}, which Lando 4 does not ship.`,
              remediation: `${versionChoice(resolution.id, supported)} Set it in the Lando 3 file, then convert again.`,
            }),
      ];
    case "resolved": {
      const { id, version, v4Type, narrowedFrom, lando3Default } = resolution;
      if (narrowedFrom !== undefined && version !== undefined)
        return [
          needsReviewServiceKey({
            ctx,
            relative,
            message: `Lando 4 ships ${id} ${version}, so ${id}:${narrowedFrom} became ${v4Type}, which tracks the newest ${version}.x release.`,
            remediation: `Check that the app works on ${id} ${version}.x; keep it on Lando 3 if it needs exactly ${narrowedFrom}.`,
          }),
        ];
      // A type that publishes no versions has one image in each release; there is nothing to compare.
      if (lando3Default === undefined || supported.length === 0) return [];
      if (version === lando3Default)
        return [
          rewrittenServiceKey({
            ctx,
            relative,
            message: `No ${id} version was set, so Lando 3 used ${id} ${lando3Default}; pinned ${v4Type} to keep it.`,
            remediation: "Change the version on purpose if the app should move to a newer release.",
          }),
        ];
      return [
        needsReviewServiceKey({
          ctx,
          relative,
          message:
            version === undefined
              ? `No ${id} version was set, so Lando 3 used ${id} ${lando3Default}. Lando 4 does not ship it and will choose the ${id} version itself${id === "node" ? " from .nvmrc or package.json engines.node" : ""}.`
              : `No ${id} version was set, so Lando 3 used ${id} ${lando3Default}. Lando 4 ships ${id} ${version}, so this converted to ${v4Type}, which tracks the newest ${version}.x release.`,
          remediation: `${versionChoice(id, supported)} Pin the one that matches the app and its data, or keep the app on Lando 3.`,
        }),
      ];
    }
    default:
      return resolution satisfies never;
  }
};
