import { Predicate, Result, Schema } from "effect";

import { makeLandoPaths } from "@lando/paths";
import { isBareRecipeReference, renderRecipeSnapshot } from "@lando/sdk/recipes";
import {
  LANDO_HOST_EVENT_ENV,
  type LandofileEvents,
  type LandofileRecipeField,
  type LandofileShape,
} from "@lando/sdk/schema";

import { isExcludedFromUserAppDefaults } from "@lando/engine/planner/app-defaults";
import {
  compileEffectiveEvents,
  hostEventStatusesForApp,
  stampPlanServices,
} from "@lando/engine/planner/effective-events";
import { loadGlobalConfigSync } from "@lando/engine/services/config";

import { lookupRecipeSnapshot } from "../../recipes/builtin/snapshots.ts";

export const HostEventAppStatus = Schema.Struct({
  event: Schema.String,
  index: Schema.Number.pipe(Schema.check(Schema.isInt()), Schema.check(Schema.isGreaterThanOrEqualTo(0))),
  step: Schema.Unknown,
  status: Schema.Literals(["active", "skipped", "deduped"]),
  reason: Schema.optionalKey(Schema.String),
});
export type HostEventAppStatus = typeof HostEventAppStatus.Type;

export interface HostEventPlanInput {
  readonly name: string;
  readonly root: string;
  readonly services: Readonly<Record<string, { readonly primary?: boolean }>>;
  readonly events?: LandofileEvents;
}

const servicePrimary = (value: unknown): boolean | undefined => {
  if (!Predicate.isObject(value) || !("primary" in value)) return undefined;
  return value.primary === true ? true : value.primary === false ? false : undefined;
};

const recipeServicesFromField = (
  recipe: LandofileRecipeField | undefined,
): Readonly<Record<string, { readonly primary?: boolean }>> => {
  if (recipe === undefined) return {};
  const recipeId = isBareRecipeReference(recipe) ? recipe : recipe.id;
  const snapshot = lookupRecipeSnapshot(recipeId);
  if (snapshot === undefined) return {};
  const options = isBareRecipeReference(recipe) ? {} : recipe.options;
  const serviceMap = isBareRecipeReference(recipe) ? {} : (recipe.services ?? {});
  const rendered = renderRecipeSnapshot(snapshot, options);
  if (Result.isFailure(rendered) || !Predicate.isObject(rendered.success)) return {};
  const services = "services" in rendered.success ? rendered.success.services : undefined;
  if (!Predicate.isObject(services)) return {};
  return Object.fromEntries(
    Object.entries(services).map(([generated, value]) => {
      const current = serviceMap[generated] ?? generated;
      const primary = servicePrimary(value);
      return [current, primary === undefined ? {} : { primary }];
    }),
  );
};

const authoredServices = (
  services: LandofileShape["services"] | undefined,
): Readonly<Record<string, { readonly primary?: boolean }>> => {
  if (services === undefined) return {};
  return Object.fromEntries(
    Object.entries(services).map(([name, value]) => {
      const primary = servicePrimary(value);
      return [name, primary === undefined ? {} : { primary }];
    }),
  );
};

/** Authored services plus recipe-generated names, keeping each recipe primary unless authored set one. */
export const hostEventServicesFromLandofile = (
  landofile: Pick<LandofileShape, "recipe" | "services">,
): Readonly<Record<string, { readonly primary?: boolean }>> => {
  const recipe = recipeServicesFromField(landofile.recipe);
  const authored = authoredServices(landofile.services);
  const names = new Set([...Object.keys(recipe), ...Object.keys(authored)]);
  return Object.fromEntries(
    [...names].map((name) => {
      const primary = authored[name]?.primary ?? recipe[name]?.primary;
      return [name, primary === undefined ? {} : { primary }];
    }),
  );
};

export const hostEventStatusesForPlan = (plan: HostEventPlanInput): ReadonlyArray<HostEventAppStatus> => {
  const paths = makeLandoPaths();
  if (
    isExcludedFromUserAppDefaults(plan.name, plan.root, {
      globalAppRoot: paths.globalAppRoot,
      scratchDir: paths.scratchDir,
    })
  ) {
    return [];
  }
  const hostEvents = loadGlobalConfigSync().hostEvents;
  if (hostEvents === undefined) return [];
  return hostEventStatusesForApp(
    compileEffectiveEvents({
      landofile: plan.events === undefined ? {} : { events: plan.events },
      hostEvents,
      services: stampPlanServices(plan.services),
      skipHostEvents: process.env[LANDO_HOST_EVENT_ENV] === "1",
    }),
  );
};

export const renderHostEventStatuses = (statuses: ReadonlyArray<HostEventAppStatus>): ReadonlyArray<string> =>
  statuses.map((entry) => {
    const reason = entry.reason === undefined ? "" : ` (${entry.reason})`;
    return `hostEvents.${entry.event}[${entry.index}]\t${entry.status}${reason}`;
  });
