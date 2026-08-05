import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, describe, expect, test } from "bun:test";

const roots: string[] = [];
type CodegenModule = {
  readonly ensureCodegenBootstrapModules: (repositoryRoot: string) => Promise<void>;
};

const isCodegenModule = (value: unknown): value is CodegenModule =>
  typeof value === "object" &&
  value !== null &&
  "ensureCodegenBootstrapModules" in value &&
  typeof value.ensureCodegenBootstrapModules === "function";

const codegenModuleUrl = pathToFileURL(resolve(import.meta.dirname, "../../../scripts/codegen.ts")).href;
const importedCodegenModule: unknown = await import(codegenModuleUrl);
if (!isCodegenModule(importedCodegenModule)) {
  throw new TypeError("codegen module does not expose its clean-checkout bootstrap");
}
const { ensureCodegenBootstrapModules } = importedCodegenModule;

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

describe("codegen clean-checkout bootstrap", () => {
  test("creates importable empty literal modules when generated sources are absent", async () => {
    // Given: a clean checkout with none of the command-graph generated modules.
    const root = await mkdtemp(join(tmpdir(), "lando-codegen-bootstrap-"));
    roots.push(root);

    // When: codegen prepares its import-time prerequisites.
    await ensureCodegenBootstrapModules(root);

    // Then: each generated module is importable with an empty literal export.
    const commandIds = await import(join(root, "core/src/cli/generated/command-ids.ts"));
    const mcpAllowlist = await import(join(root, "core/src/cli/oclif/generated/mcp-allowlist.ts"));
    const hostProxyAllowlist = await import(
      join(root, "core/src/cli/oclif/generated/host-proxy-allowlist.ts")
    );
    const commandRegistryManifest = await import(
      join(root, "core/src/cli/generated/command-registry-manifest.ts")
    );
    expect(commandIds.BUILT_IN_COMMAND_IDS).toEqual([]);
    expect(mcpAllowlist.MCP_DEFAULT_ALLOWLIST).toEqual([]);
    expect(hostProxyAllowlist.HOST_PROXY_RUNLANDO_ALLOWLIST).toEqual([]);
    expect(commandRegistryManifest.COMMAND_REGISTRY_MANIFEST.commands).toEqual({});
  });
});
