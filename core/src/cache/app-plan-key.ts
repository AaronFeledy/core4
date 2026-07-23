import { createHash } from "node:crypto";

import type {
  LandofileShape,
  PluginManifest,
  ProviderCapabilities,
  RouteAuthorityPorts,
} from "@lando/sdk/schema";

import type { VersionConstraintEntry } from "../config/version-constraint.ts";
import { CORE_VERSION } from "../version.ts";

// Bump for serialized-shape or planner-output semantic changes, including generated build intents,
// independently of the package version.
export const APP_PLAN_CACHE_SCHEMA_VERSION = 11n;

export interface AppPlanCacheKeyInput {
  readonly appRoot: string;
  readonly landofile: LandofileShape;
  readonly providerCapabilities?: ProviderCapabilities;
  readonly routeAuthorityPorts?: RouteAuthorityPorts;
  readonly pluginManifests: ReadonlyArray<PluginManifest>;
  readonly sourceFingerprint?: AppPlanSourceFingerprint;
  readonly includedFragmentShas?: ReadonlyArray<string>;
  readonly config?: unknown;
  readonly serviceInputs?: unknown;
  readonly versionConstraints?: ReadonlyArray<VersionConstraintEntry>;
}

export interface AppPlanSourceFingerprint {
  readonly landofileContentHashes: ReadonlyArray<{ readonly source: string; readonly hash: string }>;
  readonly includeLockfileHash: string | null;
  readonly includedFragmentShas: ReadonlyArray<string>;
}

const stable = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(stable);
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "bigint") return value.toString();
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, child]) => [key, stable(child)]),
    );
  }
  return value;
};

const normalizeManifest = (manifest: PluginManifest) => ({
  name: manifest.name,
  version: manifest.version,
  api: manifest.api,
  enabled: manifest.enabled ?? true,
  bundled: manifest.bundled ?? false,
  contributes: manifest.contributes ?? {},
});

export const deriveAppPlanCacheKey = (input: AppPlanCacheKeyInput): string => {
  const pluginManifests = input.pluginManifests
    .map(normalizeManifest)
    .sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version) || a.api - b.api);
  const payload = JSON.stringify(
    stable({
      cache: "app-plan",
      schemaVersion: Number(APP_PLAN_CACHE_SCHEMA_VERSION),
      landoVersion: CORE_VERSION,
      appRoot: input.appRoot,
      landofile: input.landofile,
      providerCapabilities: input.providerCapabilities ?? null,
      routeAuthorityPorts: input.routeAuthorityPorts ?? null,
      sourceFingerprint: input.sourceFingerprint ?? null,
      includedFragmentShas: [
        ...(input.sourceFingerprint?.includedFragmentShas ?? []),
        ...(input.includedFragmentShas ?? []),
      ].sort(),
      versionConstraints: input.versionConstraints ?? [],
      pluginManifests,
      config: input.config ?? null,
      serviceInputs: input.serviceInputs ?? input.landofile.services ?? {},
    }),
  );
  return createHash("sha256").update(payload).digest("hex");
};
