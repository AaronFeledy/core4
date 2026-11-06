import { isLegacyTagged, isPlainRecord, mergeLandofiles, mergeValues } from "@lando/sdk/landofile";
import { ServiceConfig } from "@lando/sdk/schema";
import type {
  ConfigTranslateDiagnostic,
  ConfigTranslateExpectation,
  ConfigTranslateSourceId,
  LandofileLayer,
} from "@lando/sdk/schema";
import { lowerBuildHooks } from "./build-hooks.ts";
import { ClaimCursor } from "./claims.ts";
import { lowerComposeFields } from "./compose-fields.ts";
import type { Lando3TranslatorPorts } from "./contract.ts";
import { dedupeDiagnostics } from "./diagnostics.ts";
import type { LegacyPrefixView } from "./effective-views.ts";
import { mergedToPlain, occurrencesAt } from "./legacy-merge.ts";
import { lowerApi4Service } from "./lower-api4.ts";
import { lowerCatalogAppMountMasks } from "./lower-catalog-app-mount-masks.ts";
import { lowerCatalogCommon } from "./lower-catalog-common.ts";
import { lowerEvents } from "./lower-events.ts";
import { lowerListenPort } from "./lower-listen-port.ts";
import { lowerPhpOptions } from "./lower-php.ts";
import { declareRouteEndpoints, lowerProxy } from "./lower-proxy.ts";
import { lowerRawService } from "./lower-raw-service.ts";
import { withHomeIntent } from "./lower-runtime-intent.ts";
import { lowerTooling } from "./lower-tooling.ts";
import { lowerTopLevel } from "./lower-top-level.ts";
import { lowerTypeOptions } from "./lower-type-options.ts";
import {
  type LoweringPatch,
  type ServiceLoweringContext,
  type V4Wire,
  hasPlainObjectPrototype,
  mergePatches,
} from "./lowering-contract.ts";
import { makeReport } from "./lowering-report.ts";
import { decodeLando3Landofile } from "./model.ts";
import { slugifyAppName } from "./naming.ts";
import { missingImage, needsReviewServiceKey, unsupportedServiceKey } from "./service-diagnostics.ts";

export interface LoweredServicePrefix {
  readonly targetLayer: LandofileLayer;
  readonly sourceIds: ReadonlyArray<ConfigTranslateSourceId>;
  readonly fragment: V4Wire;
}
export interface LoweredServices {
  readonly prefixes: ReadonlyArray<LoweredServicePrefix>;
  readonly diagnostics: ReadonlyArray<ConfigTranslateDiagnostic>;
  readonly expectations: ReadonlyArray<ConfigTranslateExpectation>;
}

const lowerService = (service: Record<string, unknown>, ctx: ServiceLoweringContext): LoweringPatch => {
  const overrides = lowerComposeFields(service.overrides ?? {}, ctx, { basePath: ["overrides"] });
  ctx.cursor?.take(["api"]);
  const raw = service.api !== 4 && (service.type === "lando" || service.type === "compose");
  const nested = raw
    ? lowerComposeFields(service.services ?? {}, ctx, { basePath: ["services"] })
    : { patch: {}, diagnostics: [] };
  const hooks = lowerBuildHooks(service, ctx, {
    ...(typeof service.meUser === "string" ? { meUser: service.meUser } : {}),
    hasComposeBuild:
      overrides.patch.build !== undefined ||
      (hasPlainObjectPrototype(nested.patch) && nested.patch.build !== undefined),
  });
  if (service.api === 4) return mergePatches(lowerApi4Service(service, ctx), hooks, overrides);
  if (raw) {
    return mergePatches(lowerRawService(service, ctx, nested), overrides, hooks);
  }
  const common = lowerCatalogCommon(service, ctx);
  switch (common.resolution._tag) {
    case "resolved":
    case "unsupported-version":
      return lowerListenPort(
        mergePatches(
          common,
          lowerTypeOptions(common.resolution.id, service, ctx),
          common.resolution.id === "php" ? lowerPhpOptions(service, ctx) : { patch: {}, diagnostics: [] },
          hooks,
          overrides,
        ),
        common.listenPort,
        ctx,
      );
    case "unknown-type": {
      const diagnostics = common.diagnostics.filter(
        ({ keyPath }) => !(keyPath.length === ctx.keyPath.length + 1 && keyPath.at(-1) === "type"),
      );
      const image = hasPlainObjectPrototype(service.overrides) ? service.overrides.image : undefined;
      if (typeof image !== "string" || image.length === 0) {
        return mergePatches(
          { patch: {}, blocked: true, diagnostics: [...diagnostics, missingImage({ ctx })] },
          hooks,
          overrides,
        );
      }
      diagnostics.push(
        needsReviewServiceKey({
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

/** What recipe decomposition and already-converted layers contribute to tooling and events. */
export interface InheritedAuthoring {
  readonly tools: ReadonlySet<string>;
  readonly recipeServices: ReadonlyArray<string>;
  /** Recipe-owned service objects. Route ports append to these in place. */
  readonly recipeServiceWires?: ReadonlyMap<string, V4Wire>;
}

const NOTHING_INHERITED: InheritedAuthoring = { tools: new Set(), recipeServices: [] };

export const lowerServiceViews = (
  folded: ReadonlyArray<LegacyPrefixView>,
  serviceFacts: Lando3TranslatorPorts["serviceFacts"],
  inherited: InheritedAuthoring = NOTHING_INHERITED,
): LoweredServices => {
  const prefixes: LoweredServicePrefix[] = [];
  const diagnostics: ConfigTranslateDiagnostic[] = [];
  const expectations = new Map<string, ConfigTranslateExpectation>();
  for (const view of folded) {
    const doc = mergedToPlain(view.merged);
    const fallbackSourceId = view.sourceIds.at(-1);
    if (!hasPlainObjectPrototype(doc) || fallbackSourceId === undefined) continue;
    const top = lowerTopLevel(doc, {
      fallbackSourceId,
      occurrenceAt: (relative) => occurrencesAt(view.merged, relative).at(-1),
    });
    diagnostics.push(...top.diagnostics);
    let topLevel = top.fragment;
    const report = makeReport(
      { fallbackSourceId, occurrenceAt: (relative) => occurrencesAt(view.merged, relative).at(-1) },
      diagnostics,
    );
    const tooling = lowerTooling(doc.tooling, report);
    const proxy = lowerProxy(doc.proxy, report);
    const events = lowerEvents(
      doc.events,
      {
        services: doc.services,
        recipeServices: view.recipe === undefined ? [] : inherited.recipeServices,
        tasks: tooling.tasks,
        inheritedTools: inherited.tools,
      },
      report,
    );
    const authored = hasPlainObjectPrototype(doc.services) ? doc.services : {};
    const unknownKeys = decodeLando3Landofile(doc).unknownKeys;
    const appSlug = slugifyAppName(typeof doc.name === "string" ? doc.name : "app");
    const services = new Map<string, V4Wire>();
    for (const [serviceName, service] of Object.entries(authored)) {
      if (service === false || service === null || service === undefined) continue;
      const location: ServiceLoweringContext = {
        serviceFacts,
        serviceName,
        appSlug,
        keyPath: ["services", serviceName],
        fallbackSourceId,
        occurrenceAt: (relative) => occurrencesAt(view.merged, ["services", serviceName, ...relative]).at(-1),
        topLevel: {
          excludes: top.appMountExcludes,
          includes: top.appMountIncludes,
          includeLocations: top.appMountIncludeLocations ?? [],
        },
      };
      const cursor = new ClaimCursor(service, location);
      const ctx: ServiceLoweringContext = { ...location, cursor };
      if (!hasPlainObjectPrototype(service) || isLegacyTagged(service)) {
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
      const lowered = withHomeIntent(lowerService(service, ctx), service, ctx);
      diagnostics.push(...lowered.diagnostics);
      const unknownRoots = unknownKeys.flatMap(([section, name, ...rest]) =>
        section === "services" && name === serviceName ? [rest] : [],
      );
      diagnostics.push(...cursor.residuals(lowered.diagnostics, unknownRoots));
      expectations.delete(serviceName);
      for (const expectation of lowered.expectations ?? []) expectations.set(serviceName, expectation);
      if (lowered.blocked === true) continue;
      const patch =
        service.api === 4 ? lowered.patch : lowerCatalogAppMountMasks(lowered.patch, top, serviceFacts);
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
        } else {
          const merged = mergeValues(ServiceConfig, services.get(name) ?? {}, companion);
          if (isPlainRecord(merged)) services.set(name, merged);
        }
      }
    }
    declareRouteEndpoints(proxy.fragment, services, report, {
      serviceFacts,
      external: inherited.recipeServiceWires ?? new Map(),
    });
    prefixes.push({
      targetLayer: view.targetLayer,
      sourceIds: view.sourceIds,
      fragment: {
        ...(services.size === 0 ? {} : { services: Object.fromEntries(services) }),
        ...(Object.keys(tooling.tooling).length === 0 ? {} : { tooling: tooling.tooling }),
        ...(Object.keys(events).length === 0 ? {} : { events }),
        ...proxy.fragment,
        ...topLevel,
      },
    });
  }
  return { prefixes, diagnostics: dedupeDiagnostics(diagnostics), expectations: [...expectations.values()] };
};
