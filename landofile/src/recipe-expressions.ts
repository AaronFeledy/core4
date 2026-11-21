import { isPlainRecord } from "@lando/sdk/landofile";
import type { ParsedPendingSite } from "@lando/sdk/schema";
import type { EnvironmentRecorder } from "./environment-dependencies.ts";
import type { LoadFailureRecorder } from "./load-failures.ts";

export const PLAN_IDENTITY_EXPRESSION_SCOPES: readonly string[] = ["app", "proxy", "recipe", "env"];
export const PLAN_SERVICE_EXPRESSION_SCOPES: readonly string[] = [
  ...PLAN_IDENTITY_EXPRESSION_SCOPES,
  "services",
  "service",
];
export const LOAD_DEFERRED_EXPRESSION_SCOPES: readonly string[] = [
  ...PLAN_IDENTITY_EXPRESSION_SCOPES,
  "services",
];
export const LOAD_RESOLVABLE_EXPRESSION_SCOPES: readonly string[] = ["recipe", "env"];

export interface LandofileLoadScope {
  readonly includeMode?: "conditional" | "all" | undefined;
  readonly siteFilter?: ((site: ParsedPendingSite) => boolean) | undefined;
  readonly recorder?: LoadFailureRecorder | undefined;
  readonly pendingSites?: ParsedPendingSite[];
  /**
   * Raw captured host environment for evaluation and CompilationContext copies.
   * Never the dependency-recording view — redaction and schema walks must not
   * mark environment dependencies Complete by enumerating this object.
   */
  readonly env: Readonly<Record<string, string>>;
  /** Optional shared recorder; expression sites and template/ts producers write here. */
  readonly environmentRecorder?: EnvironmentRecorder | undefined;
  readonly recipe: Readonly<Record<string, unknown>> | undefined;
}

/**
 * Project a process-env-shaped record to string values only.
 * Callers on the tooling/index/Landofile-load path must pass the captured
 * invocation env; do not call this with live `process.env` below host entry.
 */
export const hostExpressionEnvironment = (
  env: Readonly<Record<string, string | undefined>> = process.env,
): Record<string, string> =>
  Object.fromEntries(
    Object.entries(env).flatMap(([key, value]) => (typeof value === "string" ? [[key, value]] : [])),
  );

export const recipeOptionScope = (
  document: Record<string, unknown>,
): Readonly<Record<string, unknown>> | undefined => {
  const recipe = document.recipe;
  return isPlainRecord(recipe) && isPlainRecord(recipe.options) ? recipe.options : undefined;
};
