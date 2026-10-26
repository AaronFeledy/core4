import { CI_PLATFORMS } from "./ci-platforms.ts";

export const PROFILES = ["docs", "guides", "runtime", "providers"] as const;
export type CiProfile = (typeof PROFILES)[number];
export type CiTier = CiProfile | "broad";
export type CiSelection = { readonly profile: CiProfile; readonly broad: boolean; readonly reason: string };

// Job-level policy only. The guide tier includes the complete binary prerequisite closure.
export const CI_JOB_TIERS: Readonly<Record<string, CiTier>> = {
  "static-checks-platform": "docs",
  "static-checks": "docs",
  "docs-build": "docs",
  "schema-snapshot": "guides",
  "bundled-codegen": "guides",
  "library-api-tests-runner": "guides",
  "library-api-tests": "guides",
  "recipe-tests-runner": "guides",
  "recipe-tests": "guides",
  "container-helper": "guides",
  "container-helper-arm64": "broad",
  "build-linux-x64": "guides",
  "runtime-bundle-linux-x64": "guides",
  "guide-scenarios-linux-x64-runner": "guides",
  "guide-scenarios-linux-x64": "guides",
  "unit-tests-linux-x64-shard": "runtime",
  "unit-tests-linux-x64": "runtime",
  "test-isolation-linux-x64": "runtime",
  "perf-budget-linux-x64": "runtime",
  "runtime-bundle-win32-x64": "broad",
  "bun-install-isolated-experiment": "broad",
  ...Object.fromEntries(
    CI_PLATFORMS.flatMap(({ id }) => [
      ...(id === "linux-x64" ? [] : [`build-${id}`, `guide-scenarios-${id}`]),
      `provider-integration-${id}`,
      ...(id === "linux-x64" ? [`provider-integration-${id}-runner`] : []),
    ]).map((id) => [id, "broad" as const]),
  ),
  "provider-integration-linux-x64-runner": "providers",
  "provider-integration-linux-x64": "providers",
  "guide-scenarios-windows-x64": "guides",
};

const affectsProviders = (path: string): boolean =>
  path.startsWith("plugins/provider-") ||
  path.startsWith("plugins/service-lando/") ||
  path.startsWith("container-runtime/") ||
  path.startsWith("engine/src/providers/") ||
  path.startsWith("engine/test/providers/") ||
  path.startsWith("sdk/src/services/provider") ||
  path.startsWith("sdk/test/contract/provider") ||
  path === ".github/workflows/ci.yml" ||
  /^scripts\/(?:_ci-selection-workflow|build-ci-workflow|ci-selection|select-ci|validate-ci|test-shards)\.ts$/.test(
    path,
  );

export const selectPaths = (paths: readonly string[]): CiSelection => {
  if (paths.length === 0) return { profile: "runtime", broad: false, reason: "empty diff" };
  if (paths.some(affectsProviders))
    return { profile: "providers", broad: false, reason: "provider or CI coverage path" };
  let profile: CiProfile = "docs";
  for (const path of paths) {
    if (path.startsWith("docs/guides/")) {
      profile = "guides";
      continue;
    }
    if (
      path.startsWith("docs/public/") ||
      path.startsWith("docs/src/assets/") ||
      (path.startsWith("docs/") && /\.(md|mdx)$/.test(path))
    )
      continue;
    return { profile: "runtime", broad: false, reason: "runtime or unknown path" };
  }
  return { profile, broad: false, reason: "changed paths" };
};

export const jobSelected = (tier: CiTier, selection: CiSelection): boolean =>
  selection.broad || (tier !== "broad" && PROFILES.indexOf(selection.profile) >= PROFILES.indexOf(tier));

export const jobCondition = (tier: CiTier): string => {
  const profiles = tier === "broad" ? [] : PROFILES.slice(PROFILES.indexOf(tier));
  return `needs.selection.outputs.broad == 'true'${profiles.map((profile) => ` || needs.selection.outputs.profile == '${profile}'`).join("")}`;
};

export const resultFailures = (
  selection: CiSelection,
  results: Readonly<Record<string, { readonly result: string }>>,
): readonly string[] =>
  Object.entries(results).flatMap(([id, { result }]) => {
    if (id === "selection") return result === "success" ? [] : [`selection: ${result}`];
    const tier = CI_JOB_TIERS[id];
    if (tier === undefined) return [`unknown job: ${id}`];
    return result === "success" || (result === "skipped" && !jobSelected(tier, selection))
      ? []
      : [`${id}: ${result}`];
  });
