import { isLegacyTagged } from "@lando/sdk/landofile";
import type { ConfigTranslateDiagnostic, ConfigTranslateSourceId, LandofileLayer } from "@lando/sdk/schema";
import { lowerBuildHooks } from "./build-hooks.ts";
import { CATALOG, resolveCatalogType } from "./catalog.ts";
import { lowerComposeFields } from "./compose-fields.ts";
import { dedupeDiagnostics } from "./diagnostics.ts";
import type { LegacyPrefixView } from "./effective-views.ts";
import { mergedToPlain, occurrencesAt } from "./legacy-merge.ts";
import { lowerApi4Service } from "./lower-api4.ts";
import { lowerCatalogCommon } from "./lower-catalog-common.ts";
import { lowerPhpOptions } from "./lower-php.ts";
import { lowerTopLevel } from "./lower-top-level.ts";
import { lowerTypeOptions } from "./lower-type-options.ts";
import {
  type LoweringPatch,
  type ServiceLoweringContext,
  type V4Wire,
  asStringArray,
  isPlainObject,
  mergePatches,
} from "./lowering-contract.ts";
import { missingImage, rewrittenServiceKey, unsupportedServiceKey } from "./service-diagnostics.ts";
import { mergeLandofiles } from "./v4-merge.ts";

export interface LoweredServicePrefix {
  readonly targetLayer: LandofileLayer;
  readonly sourceIds: ReadonlyArray<ConfigTranslateSourceId>;
  readonly fragment: V4Wire;
}
export interface LoweredServices {
  readonly prefixes: ReadonlyArray<LoweredServicePrefix>;
  readonly diagnostics: ReadonlyArray<ConfigTranslateDiagnostic>;
}

const lowerService = (service: Record<string, unknown>, ctx: ServiceLoweringContext): LoweringPatch => {
  const overrides = lowerComposeFields(service.overrides ?? {}, ctx, { basePath: ["overrides"] });
  const raw = service.api !== 4 && (service.type === "lando" || service.type === "compose");
  const nested = raw
    ? lowerComposeFields(service.services ?? {}, ctx, { basePath: ["services"] })
    : { patch: {}, diagnostics: [] };
  const hooks = lowerBuildHooks(service, ctx, {
    ...(typeof service.meUser === "string" ? { meUser: service.meUser } : {}),
    hasComposeBuild:
      overrides.patch.build !== undefined ||
      (isPlainObject(nested.patch) && nested.patch.build !== undefined),
  });
  if (service.api === 4) return mergePatches(lowerApi4Service(service, ctx), hooks, overrides);
  if (raw) {
    // Raw config contains literal file contents, not catalog config slots.
    const { config: _config, ...commonFields } = service;
    const common = lowerCatalogCommon(commonFields, ctx);
    const diagnostics: ConfigTranslateDiagnostic[] = [];
    const patch: Record<string, unknown> = { type: "compose" };
    if (typeof service.meUser === "string") {
      patch.user = service.meUser;
      diagnostics.push(
        rewrittenServiceKey({
          ctx,
          relative: ["meUser"],
          message: "Rewrote meUser as the Compose service user.",
          remediation: "Review user in the generated service.",
        }),
      );
    }
    const health = lowerApi4Service({ healthcheck: service.healthcheck }, ctx);
    const { type: _type, ...healthPatch } = health.patch;
    for (const key of Object.keys(isPlainObject(service.config) ? service.config : {})) {
      diagnostics.push(
        unsupportedServiceKey({
          ctx,
          relative: ["config", key],
          message: "Raw inline file contents have no Lando 4 target.",
          remediation:
            "Create the file yourself and configure an explicit mount; conversion does not read referenced files.",
        }),
      );
    }
    const topLevel = Object.fromEntries(
      ["volumes", "networks"].flatMap((key) => (isPlainObject(service[key]) ? [[key, service[key]]] : [])),
    );
    return mergePatches(
      common,
      nested,
      { patch: healthPatch, diagnostics: health.diagnostics },
      { patch, topLevel, diagnostics },
      overrides,
      hooks,
    );
  }
  const common = lowerCatalogCommon(service, ctx);
  switch (common.resolution._tag) {
    case "resolved":
      return mergePatches(
        common,
        lowerTypeOptions(common.resolution.id, service, ctx),
        common.resolution.id === "php" ? lowerPhpOptions(service, ctx) : { patch: {}, diagnostics: [] },
        hooks,
        overrides,
      );
    case "unsupported-version":
      return mergePatches(common, hooks, overrides);
    case "unknown-type": {
      const diagnostics = common.diagnostics.filter(
        ({ keyPath }) => !(keyPath.length === ctx.keyPath.length + 1 && keyPath.at(-1) === "type"),
      );
      const image = isPlainObject(service.overrides) ? service.overrides.image : undefined;
      if (typeof image !== "string" || image.length === 0) {
        return mergePatches(
          { patch: {}, blocked: true, diagnostics: [...diagnostics, missingImage({ ctx })] },
          hooks,
          overrides,
        );
      }
      diagnostics.push(
        rewrittenServiceKey({
          ctx,
          relative: ["type"],
          message: `Service type ${common.resolution.id} uses a Compose fallback with its explicit image.`,
          remediation: "Review the Compose service and its image before starting the app.",
        }),
      );
      return mergePatches(
        { patch: { ...common.patch, type: "compose", image }, diagnostics },
        hooks,
        overrides,
      );
    }
    default:
      return common.resolution satisfies never;
  }
};

/**
 * Lando 3's top-level `excludes` only ever reached the app mount, so it applies
 * to the services whose lowered Lando 4 type mounts the app. The target type is
 * what decides that, not the authored one: a raw Compose or unknown-image
 * service lowers to `type: compose`, which mounts the app on its own.
 */
const mountsAppByDefault = (loweredType: unknown): boolean => {
  if (typeof loweredType !== "string") return false;
  const resolution = resolveCatalogType(loweredType);
  if (resolution._tag === "unknown-type") return false;
  return CATALOG[resolution.id]?.appMountByDefault === true;
};

export const lowerServiceViews = (folded: ReadonlyArray<LegacyPrefixView>): LoweredServices => {
  const prefixes: LoweredServicePrefix[] = [];
  const diagnostics: ConfigTranslateDiagnostic[] = [];
  for (const view of folded) {
    const doc = mergedToPlain(view.merged);
    const fallbackSourceId = view.sourceIds.at(-1);
    if (!isPlainObject(doc) || fallbackSourceId === undefined) continue;
    const top = lowerTopLevel(doc, {
      fallbackSourceId,
      occurrenceAt: (relative) => occurrencesAt(view.merged, relative).at(-1),
    });
    diagnostics.push(...top.diagnostics);
    let topLevel = top.fragment;
    const authored = isPlainObject(doc.services) ? doc.services : {};
    const services = new Map<string, V4Wire>();
    for (const [serviceName, service] of Object.entries(authored)) {
      if (service === false || service === null || service === undefined) continue;
      const ctx: ServiceLoweringContext = {
        serviceName,
        keyPath: ["services", serviceName],
        fallbackSourceId,
        occurrenceAt: (relative) => occurrencesAt(view.merged, ["services", serviceName, ...relative]).at(-1),
        topLevel: { excludes: top.appMountExcludes, includes: top.appMountIncludes },
      };
      if (!isPlainObject(service) || isLegacyTagged(service)) {
        diagnostics.push(
          unsupportedServiceKey({
            ctx,
            relative: [],
            message: "Service must be an explicit mapping to convert.",
            remediation: "Inline the service mapping; tagged references are not read.",
          }),
        );
        continue;
      }
      const lowered = lowerService(service, ctx);
      diagnostics.push(...lowered.diagnostics);
      if (lowered.blocked === true) continue;
      let patch = lowered.patch;
      if (
        patch.appMount !== false &&
        mountsAppByDefault(patch.type) &&
        (top.appMountExcludes.length > 0 || top.appMountIncludes.length > 0)
      ) {
        const app = isPlainObject(patch.appMount) ? patch.appMount : {};
        patch = {
          ...patch,
          appMount: {
            target: "/app",
            ...app,
            excludes: [...new Set([...top.appMountExcludes, ...(asStringArray(app.excludes) ?? [])])],
            includes: [...new Set([...top.appMountIncludes, ...(asStringArray(app.includes) ?? [])])],
          },
        };
      }
      services.set(serviceName, patch);
      topLevel = mergeLandofiles([topLevel, lowered.topLevel ?? {}]);
      for (const [name, companion] of Object.entries(lowered.companions ?? {})) {
        if (Object.hasOwn(authored, name)) {
          diagnostics.push(
            unsupportedServiceKey({
              ctx,
              relative: [],
              message: `Generated companion ${name} collides with an authored service.`,
              remediation: `Rename the authored ${name} service or configure the companion manually.`,
            }),
          );
        } else services.set(name, mergeLandofiles([services.get(name) ?? {}, companion]));
      }
    }
    prefixes.push({
      targetLayer: view.targetLayer,
      sourceIds: view.sourceIds,
      fragment: {
        ...(services.size === 0 ? {} : { services: Object.fromEntries(services) }),
        ...topLevel,
      },
    });
  }
  return { prefixes, diagnostics: dedupeDiagnostics(diagnostics) };
};
