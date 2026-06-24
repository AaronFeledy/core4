// Test helper assembling a §6.11 `ServiceType` whose plan body still lives
// under the core-private `__legacyToServicePlan` bridge. Mirrors the catalog's
// `defineLegacyServiceType`; the planner consumes the bridge via
// `core/src/services/legacy-service-plan.ts` until the composition pipeline
// (US-359) lands. Delete with the bridge.
import { Effect, Schema } from "effect";

import type { ServicePlan } from "@lando/sdk/schema";
import type { ServiceType, ServiceTypeInput, ServiceTypeResolution } from "@lando/sdk/services";

import type { LegacyServicePlanInput } from "../../src/services/legacy-service-plan.ts";

export interface LegacyServiceTypeFake extends ServiceType {
  readonly __legacyToServicePlan: (input: LegacyServicePlanInput) => ServicePlan;
}

export interface MakeLegacyServiceTypeFakeOptions {
  readonly id: string;
  readonly name?: string;
  readonly base?: "l337" | "lando";
  readonly toServicePlan: (input: LegacyServicePlanInput) => ServicePlan;
}

/** Build a `ServiceType` fake backed by an existing plan body (legacy bridge). */
export const makeLegacyServiceTypeFake = (
  options: MakeLegacyServiceTypeFakeOptions,
): LegacyServiceTypeFake => ({
  id: options.id,
  name: options.name ?? options.id,
  base: options.base ?? "lando",
  schema: Schema.Unknown,
  resolve: (input: ServiceTypeInput): Effect.Effect<ServiceTypeResolution, never> =>
    Effect.succeed({ base: options.base ?? "lando", normalizedConfig: input.service, features: [] }),
  __legacyToServicePlan: options.toServicePlan,
});
