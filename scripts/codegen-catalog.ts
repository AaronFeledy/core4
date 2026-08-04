import { resolve } from "node:path";

/** Ordered source of truth for codegen execution and output ownership. */
export type CodegenOwnership = "committed-pin" | "committed-workflow" | "derived";
export type CodegenWorkspace = "repo" | "core";

export type CodegenCatalogEntry = {
  readonly id: string;
  readonly ownership: CodegenOwnership;
  readonly script: string;
  readonly workspace: CodegenWorkspace;
};

export type CodegenCommand = {
  readonly cmd: ReadonlyArray<string>;
  readonly cwd: string;
};

export const CODEGEN_CATALOG = [
  {
    id: "build-guide-scenarios",
    ownership: "derived",
    script: "build-guide-scenarios.ts",
    workspace: "repo",
  },
  {
    id: "build-recipe-readmes",
    ownership: "derived",
    script: "build-recipe-readmes.ts",
    workspace: "repo",
  },
  {
    id: "bundled-plugins",
    ownership: "derived",
    script: "build-bundled-plugins.ts",
    workspace: "repo",
  },
  {
    id: "mutagen-versions",
    ownership: "committed-pin",
    script: "build-mutagen-versions.ts",
    workspace: "repo",
  },
  {
    id: "provider-images",
    ownership: "derived",
    script: "build-provider-images.ts",
    workspace: "repo",
  },
  {
    id: "compose-fixture-manifest",
    ownership: "derived",
    script: "build-compose-fixture-manifest.ts",
    workspace: "repo",
  },
  {
    id: "bundled-recipes",
    ownership: "derived",
    script: "build-bundled-recipes.ts",
    workspace: "repo",
  },
  {
    id: "bootstrap-layers",
    ownership: "derived",
    script: "build-bootstrap-layers.ts",
    workspace: "repo",
  },
  {
    id: "setup-plugin-flags",
    ownership: "derived",
    script: "build-setup-plugin-flags.ts",
    workspace: "repo",
  },
  {
    id: "mcp-allowlist",
    ownership: "derived",
    script: "build-mcp-allowlist.ts",
    workspace: "repo",
  },
  {
    id: "host-proxy-allowlist",
    ownership: "derived",
    script: "build-host-proxy-allowlist.ts",
    workspace: "repo",
  },
  {
    id: "oclif-manifest",
    ownership: "derived",
    script: "build-oclif-manifest.ts",
    workspace: "core",
  },
  {
    id: "schema-snapshot",
    ownership: "derived",
    script: "build-schema-snapshot.ts",
    workspace: "repo",
  },
  {
    id: "command-reference",
    ownership: "derived",
    script: "build-command-reference.ts",
    workspace: "repo",
  },
  {
    id: "compose-key-matrix",
    ownership: "derived",
    script: "build-compose-key-matrix.ts",
    workspace: "repo",
  },
  {
    id: "opentui-native-stubs",
    ownership: "derived",
    script: "build-opentui-native-stubs.ts",
    workspace: "repo",
  },
  {
    id: "php-base-images",
    ownership: "derived",
    script: "build-php-base-images.ts",
    workspace: "repo",
  },
  {
    id: "ci-workflow",
    ownership: "committed-workflow",
    script: "build-ci-workflow.ts",
    workspace: "repo",
  },
  {
    id: "nightly-workflow",
    ownership: "committed-workflow",
    script: "build-nightly-workflow.ts",
    workspace: "repo",
  },
  {
    id: "release-workflow",
    ownership: "committed-workflow",
    script: "build-release-workflow.ts",
    workspace: "repo",
  },
  {
    id: "provider-matrix-workflow",
    ownership: "committed-workflow",
    script: "build-provider-matrix-workflow.ts",
    workspace: "repo",
  },
  {
    id: "runtime-bundle-workflow",
    ownership: "committed-workflow",
    script: "build-runtime-bundle-workflow.ts",
    workspace: "repo",
  },
  {
    id: "php-base-workflow",
    ownership: "committed-workflow",
    script: "build-php-base-workflow.ts",
    workspace: "repo",
  },
  {
    id: "compose-vendor-bump-workflow",
    ownership: "committed-workflow",
    script: "build-compose-vendor-bump-workflow.ts",
    workspace: "repo",
  },
] as const satisfies readonly CodegenCatalogEntry[];

const SCRIPT_DIRECTORY = import.meta.dirname;
const REPOSITORY_ROOT = resolve(SCRIPT_DIRECTORY, "..");
const WORKSPACE_ROOTS = {
  repo: REPOSITORY_ROOT,
  core: resolve(REPOSITORY_ROOT, "core"),
} as const satisfies Record<CodegenWorkspace, string>;

export const resolveCodegenCommand = (entry: CodegenCatalogEntry): CodegenCommand => ({
  cmd: [process.execPath, "run", resolve(SCRIPT_DIRECTORY, entry.script)],
  cwd: WORKSPACE_ROOTS[entry.workspace],
});
