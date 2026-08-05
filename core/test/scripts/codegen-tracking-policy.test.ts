import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

type CatalogEntry = {
  readonly id: string;
  readonly ownership: "committed-pin" | "committed-workflow" | "derived";
};

type CodegenCatalogModule = {
  readonly CODEGEN_CATALOG: readonly CatalogEntry[];
};

const derivedTypeScriptPolicies = [
  {
    ids: ["command-registry-manifest"],
    ignoreProbe: "core/src/cli/generated/command-ids.ts",
    trackingPath: "core/src/cli/generated",
  },
  {
    ids: ["setup-plugin-flags", "mcp-allowlist", "host-proxy-allowlist"],
    ignoreProbe: "core/src/cli/oclif/generated/setup-plugin-flags.ts",
    trackingPath: "core/src/cli/oclif/generated",
  },
  {
    ids: ["provider-images"],
    ignoreProbe: "core/src/data-mover/generated/provider-images.ts",
    trackingPath: "core/src/data-mover/generated/provider-images.ts",
  },
  {
    ids: ["bundled-plugins"],
    ignoreProbe: "core/src/plugins/generated/bundled.ts",
    trackingPath: "core/src/plugins/generated",
  },
  {
    ids: ["bundled-recipes"],
    ignoreProbe: "core/src/recipes/bundled.ts",
    trackingPath: "core/src/recipes/bundled.ts",
  },
  {
    ids: ["bootstrap-layers"],
    ignoreProbe: "core/src/runtime/generated/layers/index.ts",
    trackingPath: "core/src/runtime/generated/layers",
  },
  {
    ids: ["opentui-native-stubs"],
    ignoreProbe: "scripts/generated/opentui-native/catalog.generated.ts",
    trackingPath: "scripts/generated/opentui-native",
  },
] as const;

const committedWorkflowPolicies = [
  { id: "ci-workflow", path: ".github/workflows/ci.yml" },
  { id: "nightly-workflow", path: ".github/workflows/nightly.yml" },
  { id: "release-workflow", path: ".github/workflows/release.yml" },
  { id: "provider-matrix-workflow", path: ".github/workflows/provider-matrix.yml" },
  { id: "runtime-bundle-workflow", path: ".github/workflows/runtime-bundle.yml" },
  { id: "php-base-workflow", path: ".github/workflows/php-base-images.yml" },
  { id: "compose-vendor-bump-workflow", path: ".github/workflows/compose-vendor-bump.yml" },
] as const;

const isCodegenCatalogModule = (value: unknown): value is CodegenCatalogModule =>
  typeof value === "object" &&
  value !== null &&
  "CODEGEN_CATALOG" in value &&
  Array.isArray(value.CODEGEN_CATALOG) &&
  value.CODEGEN_CATALOG.every(
    (entry: unknown) =>
      typeof entry === "object" &&
      entry !== null &&
      "id" in entry &&
      typeof entry.id === "string" &&
      "ownership" in entry &&
      (entry.ownership === "committed-pin" ||
        entry.ownership === "committed-workflow" ||
        entry.ownership === "derived"),
  );

const repositoryRoot = resolve(import.meta.dirname, "../../..");
const catalogModuleUrl = pathToFileURL(resolve(repositoryRoot, "scripts/codegen-catalog.ts")).href;
const importedCatalogModule: unknown = await import(catalogModuleUrl);
if (!isCodegenCatalogModule(importedCatalogModule)) {
  throw new TypeError("codegen catalog module does not satisfy its tracking-policy contract");
}
const catalogById = new Map(importedCatalogModule.CODEGEN_CATALOG.map((entry) => [entry.id, entry]));

const runGit = async (
  args: readonly string[],
): Promise<{ readonly exitCode: number; readonly stdout: string }> => {
  const child = Bun.spawn({
    cmd: ["git", ...args],
    cwd: repositoryRoot,
    stderr: "ignore",
    stdout: "pipe",
  });
  const [exitCode, stdout] = await Promise.all([child.exited, new Response(child.stdout).text()]);
  return { exitCode, stdout };
};

describe("codegen tracking policy", () => {
  test("keeps derived TypeScript families ignored and untracked under their catalog generators", async () => {
    // When
    const policies = await Promise.all(
      derivedTypeScriptPolicies.map(async ({ ids, ignoreProbe, trackingPath }) => ({
        ids,
        ignored: await runGit(["check-ignore", "--no-index", "--quiet", "--", ignoreProbe]),
        tracked: await runGit(["ls-files", "--", trackingPath]),
      })),
    );

    // Then
    for (const policy of policies) {
      expect(policy.ids.map((id) => catalogById.get(id)?.ownership)).toEqual(policy.ids.map(() => "derived"));
      expect(policy.ignored.exitCode).toBe(0);
      expect(policy.tracked.stdout).toBe("");
    }
  });

  test("keeps committed workflow outputs tracked and outside ignore policy", async () => {
    // When
    const policies = await Promise.all(
      committedWorkflowPolicies.map(async ({ id, path }) => ({
        id,
        ignored: await runGit(["check-ignore", "--no-index", "--quiet", "--", path]),
        path,
        tracked: await runGit(["ls-files", "--", path]),
      })),
    );

    // Then
    for (const policy of policies) {
      expect(catalogById.get(policy.id)?.ownership).toBe("committed-workflow");
      expect(policy.ignored.exitCode).toBe(1);
      expect(policy.tracked.stdout.trim()).toBe(policy.path);
    }
  });
});
