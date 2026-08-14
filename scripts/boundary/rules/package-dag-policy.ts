export type WorkspaceEdgeKind = "dependencies" | "devDependencies";

export type AllowedWorkspaceTargets = readonly string[] | "workspace";

export type WorkspaceEdgePolicy = {
  readonly dependencies: AllowedWorkspaceTargets;
  readonly devDependencies: AllowedWorkspaceTargets;
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

const DOCS_BUILD_SOURCE_TARGETS = ["@lando/core", "@lando/sdk"] as const;

export const WORKSPACE_EDGE_TABLE: Readonly<Record<string, WorkspaceEdgePolicy>> = {
  "@lando/core": { dependencies: "workspace", devDependencies: "workspace" },
  // The private docs site is an embedding-host-shaped build consumer; a runtime core dependency stays forbidden.
  "@lando/docs": {
    dependencies: [],
    devDependencies: [...DOCS_BUILD_SOURCE_TARGETS],
  },
  "@lando/sdk": { dependencies: [], devDependencies: [] },
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
    ],
    devDependencies: [],
  },
  "@lando/ca-mkcert": { dependencies: PLUGIN_RUNTIME_TARGETS, devDependencies: [] },
  "@lando/file-sync-mutagen": { dependencies: PLUGIN_RUNTIME_TARGETS, devDependencies: [] },
  "@lando/logger-pretty": { dependencies: PLUGIN_RUNTIME_TARGETS, devDependencies: [] },
  "@lando/notify-lando": { dependencies: PLUGIN_RUNTIME_TARGETS, devDependencies: [] },
  "@lando/provider-docker": { dependencies: PLUGIN_RUNTIME_TARGETS, devDependencies: [] },
  "@lando/provider-lando": {
    dependencies: PLUGIN_RUNTIME_TARGETS,
    devDependencies: ["@lando/core"],
  },
  "@lando/provider-podman": {
    dependencies: [...PLUGIN_RUNTIME_TARGETS, "@lando/provider-lando"],
    devDependencies: [],
  },
  "@lando/proxy-traefik": { dependencies: PLUGIN_RUNTIME_TARGETS, devDependencies: [] },
  "@lando/renderer-lando": {
    dependencies: PLUGIN_RUNTIME_TARGETS,
    devDependencies: ["@lando/paths"],
  },
  "@lando/service-lando": {
    dependencies: PLUGIN_RUNTIME_TARGETS,
    devDependencies: ["@lando/core"],
  },
  "@lando/template-handlebars": { dependencies: PLUGIN_RUNTIME_TARGETS, devDependencies: [] },
  "@lando/template-mustache": { dependencies: PLUGIN_RUNTIME_TARGETS, devDependencies: [] },
};

export const WORKSPACE_PACKAGE_NAMES: readonly string[] = Object.freeze(Object.keys(WORKSPACE_EDGE_TABLE));

export const isWorkspaceTargetAllowed = (targets: AllowedWorkspaceTargets, target: string): boolean =>
  targets === "workspace" || targets.includes(target);

export const isWorkspaceRuntimeTargetAllowed = (source: string, target: string): boolean => {
  if (source === "@lando/docs") {
    return (DOCS_BUILD_SOURCE_TARGETS as readonly string[]).includes(target);
  }
  const policy = WORKSPACE_EDGE_TABLE[source];
  return policy !== undefined && isWorkspaceTargetAllowed(policy.dependencies, target);
};

export const packageMatches = (specifier: string, packageName: string): boolean => {
  const normalized = specifier.replaceAll("\\", "/");
  return normalized === packageName || normalized.startsWith(`${packageName}/`);
};
