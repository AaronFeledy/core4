export type WorkspaceEdgeKind = "dependencies" | "devDependencies";

export type AllowedWorkspaceTargets = readonly string[] | "workspace";

export type WorkspaceEdgePolicy = {
  readonly dependencies: AllowedWorkspaceTargets;
  readonly devDependencies: AllowedWorkspaceTargets;
  /** Source-import allowance; defaults to dependencies. */
  readonly sourceTargets?: AllowedWorkspaceTargets;
  /** Test-import allowance; defaults to dependencies plus devDependencies. */
  readonly testTargets?: AllowedWorkspaceTargets;
};

export type WorkspaceManifest = {
  readonly name: string;
  readonly path: string;
  readonly dependencies: readonly string[];
  readonly devDependencies: readonly string[];
};

export const GENERATED_COMPOSITION_PREFIXES = [
  "core/src/plugins/generated/",
  "core/src/runtime/generated/layers/",
] as const;

const PLUGIN_RUNTIME_TARGETS = [
  "@lando/sdk",
  "@lando/paths",
  "@lando/state-store",
  "@lando/container-runtime",
  "@lando/landofile",
] as const;

/**
 * Plugin test trees may reach engine-owned doubles (`@lando/engine/testing/*`) and
 * engine Live layers, but never `@lando/core`: core is the composition root above
 * plugins, and a plugin must be testable without it.
 */
const PLUGIN_TEST_TARGETS = ["@lando/engine"] as const;

const DOCS_BUILD_SOURCE_TARGETS = ["@lando/core", "@lando/sdk"] as const;

export const WORKSPACE_EDGE_TABLE: Readonly<Record<string, WorkspaceEdgePolicy>> = {
  "@lando/core": { dependencies: "workspace", devDependencies: "workspace" },
  // The private docs site is an embedding-host-shaped build consumer; a runtime core dependency stays forbidden.
  "@lando/docs": {
    dependencies: [],
    devDependencies: [...DOCS_BUILD_SOURCE_TARGETS],
    sourceTargets: [...DOCS_BUILD_SOURCE_TARGETS],
  },
  "@lando/sdk": {
    dependencies: [],
    devDependencies: [],
    // `sdk/test/library` proves the `@lando/core/*` re-export surface mirrors the SDK in a dedicated CI job.
    testTargets: ["@lando/core"],
  },
  "@lando/paths": { dependencies: ["@lando/sdk"], devDependencies: [] },
  "@lando/state-store": {
    dependencies: ["@lando/sdk", "@lando/paths"],
    devDependencies: [],
  },
  "@lando/container-runtime": { dependencies: ["@lando/sdk"], devDependencies: [] },
  "@lando/redaction": { dependencies: ["@lando/sdk"], devDependencies: [] },
  "@lando/http-client": { dependencies: ["@lando/sdk"], devDependencies: [] },
  "@lando/managed-file": {
    dependencies: ["@lando/sdk", "@lando/paths", "@lando/state-store", "@lando/redaction"],
    devDependencies: [],
  },
  "@lando/data-mover": {
    dependencies: [
      "@lando/sdk",
      "@lando/paths",
      "@lando/landofile",
      "@lando/redaction",
      "@lando/state-store",
    ],
    devDependencies: [],
    // Data-mover tests drive the engine `ProcessRunner` Live layer; a `@lando/data-mover/testing` double should replace this.
    testTargets: [
      "@lando/sdk",
      "@lando/paths",
      "@lando/landofile",
      "@lando/redaction",
      "@lando/state-store",
      "@lando/engine",
    ],
  },
  "@lando/telemetry": { dependencies: ["@lando/sdk"], devDependencies: [] },
  "@lando/renderer": {
    dependencies: ["@lando/sdk", "@lando/engine", "@lando/redaction"],
    devDependencies: [],
  },
  "@lando/mcp": {
    dependencies: ["@lando/sdk", "@lando/engine", "@lando/redaction"],
    devDependencies: [],
  },
  "@lando/landofile": {
    dependencies: ["@lando/sdk", "@lando/paths", "@lando/state-store"],
    devDependencies: [],
  },
  "@lando/engine": {
    dependencies: [
      "@lando/sdk",
      "@lando/paths",
      "@lando/state-store",
      "@lando/container-runtime",
      "@lando/landofile",
      "@lando/redaction",
      "@lando/http-client",
      "@lando/telemetry",
    ],
    // Engine base-composition tests exercise the bundled service feature definitions.
    devDependencies: ["@lando/service-lando"],
    // Engine scenario/contract tests still compose bundled plugins and renderer IO directly. Each
    // entry below is an inherited inversion to retire, not a licence for new ones.
    testTargets: [
      "@lando/sdk",
      "@lando/paths",
      "@lando/state-store",
      "@lando/container-runtime",
      "@lando/landofile",
      "@lando/redaction",
      "@lando/http-client",
      "@lando/telemetry",
      "@lando/managed-file",
      "@lando/renderer",
      "@lando/service-lando",
      "@lando/provider-docker",
      "@lando/provider-lando",
      "@lando/provider-podman",
      "@lando/proxy-traefik",
      "@lando/ca-mkcert",
      "@lando/template-mustache",
    ],
  },
  "@lando/ca-mkcert": { dependencies: PLUGIN_RUNTIME_TARGETS, devDependencies: [] },
  "@lando/file-sync-mutagen": { dependencies: PLUGIN_RUNTIME_TARGETS, devDependencies: [] },
  "@lando/notify-lando": { dependencies: PLUGIN_RUNTIME_TARGETS, devDependencies: [] },
  "@lando/sql": { dependencies: PLUGIN_RUNTIME_TARGETS, devDependencies: [] },
  "@lando/provider-docker": {
    dependencies: PLUGIN_RUNTIME_TARGETS,
    devDependencies: PLUGIN_TEST_TARGETS,
  },
  "@lando/provider-lando": {
    dependencies: PLUGIN_RUNTIME_TARGETS,
    devDependencies: PLUGIN_TEST_TARGETS,
    // The exec-env integration test composes the bundled service plugin against the managed runtime.
    testTargets: [...PLUGIN_RUNTIME_TARGETS, ...PLUGIN_TEST_TARGETS, "@lando/service-lando"],
  },
  "@lando/provider-podman": {
    dependencies: PLUGIN_RUNTIME_TARGETS,
    devDependencies: PLUGIN_TEST_TARGETS,
  },
  "@lando/lando3": {
    // Decode-only frontend. Workspace dependencies stop at the SDK and paths.
    dependencies: ["@lando/sdk", "@lando/paths"],
    devDependencies: [],
  },
  "@lando/lando4": { dependencies: PLUGIN_RUNTIME_TARGETS, devDependencies: [] },
  "@lando/proxy-traefik": { dependencies: PLUGIN_RUNTIME_TARGETS, devDependencies: [] },
  "@lando/renderer-lando": {
    dependencies: PLUGIN_RUNTIME_TARGETS,
    devDependencies: [...PLUGIN_TEST_TARGETS, "@lando/renderer", "@lando/paths"],
  },
  "@lando/service-lando": {
    dependencies: PLUGIN_RUNTIME_TARGETS,
    devDependencies: [...PLUGIN_TEST_TARGETS, "@lando/provider-docker", "@lando/provider-lando"],
  },
  "@lando/ssh-agent": { dependencies: PLUGIN_RUNTIME_TARGETS, devDependencies: [] },
  "@lando/secret-store-1password": { dependencies: PLUGIN_RUNTIME_TARGETS, devDependencies: [] },
  "@lando/template-handlebars": { dependencies: PLUGIN_RUNTIME_TARGETS, devDependencies: [] },
  "@lando/template-mustache": { dependencies: PLUGIN_RUNTIME_TARGETS, devDependencies: [] },
};

export const WORKSPACE_PACKAGE_NAMES: readonly string[] = Object.freeze(Object.keys(WORKSPACE_EDGE_TABLE));

export const isWorkspaceTargetAllowed = (targets: AllowedWorkspaceTargets, target: string): boolean =>
  targets === "workspace" || targets.includes(target);

export const isWorkspaceRuntimeTargetAllowed = (source: string, target: string): boolean => {
  const policy = WORKSPACE_EDGE_TABLE[source];
  return (
    policy !== undefined && isWorkspaceTargetAllowed(policy.sourceTargets ?? policy.dependencies, target)
  );
};

export const isWorkspaceTestTargetAllowed = (source: string, target: string): boolean => {
  const policy = WORKSPACE_EDGE_TABLE[source];
  if (policy === undefined) return false;
  if (policy.testTargets !== undefined) return isWorkspaceTargetAllowed(policy.testTargets, target);
  return (
    isWorkspaceTargetAllowed(policy.dependencies, target) ||
    isWorkspaceTargetAllowed(policy.devDependencies, target)
  );
};

export const packageMatches = (specifier: string, packageName: string): boolean => {
  const normalized = specifier.replaceAll("\\", "/");
  return normalized === packageName || normalized.startsWith(`${packageName}/`);
};
