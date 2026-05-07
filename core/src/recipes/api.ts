/**
 * `RecipeDefinition` contract.
 *
 * Recipes are plugin-provided presets that expand into services, tooling,
 * events, routes, and default config. Recipes are pure functions: given
 * input config, they produce a `RecipeExpansion`.
 *
 * Rules:
 * - Recipe output is merged before user Landofile overrides.
 * - Recipes MUST declare an Effect Schema for accepted `config:` keys.
 * - Recipes MUST NOT assume a specific provider unless their manifest
 *   declares the requirement.
 * - Recipes MAY contribute plugin requirements via `plugins:`; missing
 *   requirements emit `RecipeMissingPluginError`.
 */
import type { Effect, Schema } from "effect";

import type { RecipeError } from "@lando/sdk/errors";
import type { ServiceConfig } from "@lando/sdk/schema";

export interface RecipeInput {
  readonly config: Readonly<Record<string, unknown>>;
  readonly cwd: string;
}

export interface RecipeExpansion {
  readonly services?: Readonly<Record<string, ServiceConfig>>;
  readonly tooling?: Readonly<Record<string, unknown>>;
  readonly events?: Readonly<Record<string, ReadonlyArray<unknown>>>;
  readonly proxy?: Readonly<Record<string, ReadonlyArray<unknown>>>;
  readonly plugins?: Readonly<Record<string, unknown>>;
}

export interface RecipeDefinition {
  readonly name: string;
  readonly schema: Schema.Schema<unknown>;
  readonly expand: (input: RecipeInput) => Effect.Effect<RecipeExpansion, RecipeError>;
}
