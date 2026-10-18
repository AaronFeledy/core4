/**
 * Fail-fast check that derived codegen outputs exist before tests or the
 * source CLI try to resolve them. Effect-free; node:fs + node:path only.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";

export const DERIVED_CODEGEN_SENTINELS = [
  "core/src/plugins/generated/bundled.ts",
  "core/src/runtime/generated/layers/index.ts",
  "core/src/cli/generated/command-registry-manifest.ts",
  "core/src/cli/generated/compiled-decoders.mjs",
  "core/src/recipes/bundled.ts",
  "mcp/src/generated/mcp-allowlist.ts",
  "engine/src/deprecation/generated/schema-deprecations.ts",
  "data-mover/src/generated/provider-images.ts",
] as const;

export const missingDerivedCodegen = (repoRoot: string): string[] =>
  DERIVED_CODEGEN_SENTINELS.filter((relative) => !existsSync(join(repoRoot, relative))).map(
    (relative) => relative,
  );

export const derivedCodegenMessage = (missing: string[]): string =>
  `Generated modules are missing (${missing.length} of 8): ${missing.join(", ")}. Run \`bun run codegen\` from the repo root, then retry.`;

export const assertDerivedCodegen = (repoRoot: string): void => {
  const missing = missingDerivedCodegen(repoRoot);
  if (missing.length > 0) {
    throw new Error(derivedCodegenMessage(missing));
  }
};
