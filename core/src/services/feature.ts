/**
 * `ServiceFeature` schema + composer.
 *
 * Service features are deterministic, idempotent functions that mutate an
 * in-memory `ServicePlanContext`. Features are the v4 replacement for the
 * SPEC2 "packages" pattern.
 *
 * Feature rules:
 * - Features run in deterministic priority order. Lower priority runs first.
 * - Features mutate only the in-memory plan context.
 * - Features must be idempotent across replanning and rebuilds.
 * - Feature conflicts are declared in the manifest (`conflicts:`) or
 *   surfaced as typed planning errors.
 * - Provider-specific feature behavior is gated on `requires:` capabilities.
 * - Features emit provider-neutral plan changes. Provider-extension config
 *   under `providers.<id>` is permitted only when the feature explicitly
 *   opts in.
 *
 * Status: stub.
 */
import type { Effect, Schema } from "effect";

import type { ServiceFeatureError } from "@lando/sdk/errors";
import type { ProviderCapabilities } from "@lando/sdk/schema";

/**
 * In-memory plan context that features mutate. Built from a frozen Landofile
 * and the resolved `ServiceTypeResolution`.
 *
 * Status: stub. The full shape (with mounts, endpoints, env, packages,
 * etc.) lands as the planner stabilizes.
 */
export interface ServiceFeatureContext {
  readonly serviceName: string;
  readonly serviceType: string;
  readonly providerId: string;
  // TODO: add the full mutable plan-context surface.
}

/**
 * `ServiceFeatureDefinition`.
 */
export interface ServiceFeatureDefinition {
  readonly id: string;
  readonly schema?: Schema.Schema<unknown>;
  readonly priority: number;
  readonly requires?: ReadonlyArray<keyof ProviderCapabilities>;
  readonly apply: (ctx: ServiceFeatureContext) => Effect.Effect<void, ServiceFeatureError>;
}

/**
 * Built-in feature priority bands from `@lando/service-lando`.
 * Replicated here so core can validate + sort without importing the plugin.
 */
export const LANDO_FEATURE_PRIORITY = {
  "lando.boot": 100,
  "lando.system": 200,
  "lando.user-mapping": 300,
  "lando.tooling": 400,
  "lando.storage": 500,
  "lando.config": 600,
  "lando.env": 700,
  "lando.app-mount": 800,
  "lando.healthcheck": 900,
  "lando.certs": 1000,
  "lando.security": 1100,
  "lando.ssh-agent": 1200,
  "lando.git": 1300,
  "lando.sudo": 1400,
  "lando.proxy": 1500,
  "lando.user-image": 1900,
  "lando.user-run": 2000,
} as const;
