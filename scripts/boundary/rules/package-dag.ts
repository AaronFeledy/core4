import { relative } from "node:path";

import { collectManifests } from "../graph.ts";
import type { BoundaryRule, ProgramContext } from "../types.ts";

type EdgeKind = "dependencies" | "devDependencies";
type AllowedTargets = readonly string[] | "workspace";

type WorkspaceEdgePolicy = {
  readonly dependencies: AllowedTargets;
  readonly devDependencies: AllowedTargets;
};

type WorkspaceManifest = {
  readonly name: string;
  readonly path: string;
  readonly dependencies: readonly string[];
  readonly devDependencies: readonly string[];
};

const PLUGIN_RUNTIME_TARGETS = [
  "@lando/sdk",
  "@lando/paths",
  "@lando/state-store",
  "@lando/container-runtime",
  "@lando/landofile",
] as const;

export const WORKSPACE_EDGE_TABLE: Readonly<Record<string, WorkspaceEdgePolicy>> = {
  "@lando/core": { dependencies: "workspace", devDependencies: "workspace" },
  "@lando/sdk": { dependencies: [], devDependencies: [] },
  "@lando/paths": { dependencies: ["@lando/sdk"], devDependencies: [] },
  "@lando/state-store": {
    dependencies: ["@lando/sdk", "@lando/paths"],
    devDependencies: [],
  },
  "@lando/container-runtime": { dependencies: ["@lando/sdk"], devDependencies: [] },
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

const PACKAGE_DAG_SCOPE = {
  roots: ["."],
  extensions: [".json"],
  excludeDirNames: [".git", ".local", ".codegraph", "node_modules", "dist"],
} as const;

const normalizePath = (path: string): string => path.replaceAll("\\", "/");

const isJsonObject = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const dependencyNames = (value: unknown): readonly string[] =>
  isJsonObject(value) ? Object.keys(value).sort() : [];

const readWorkspaceManifest = async (manifest: string, root: string): Promise<WorkspaceManifest> => {
  const parsed: unknown = JSON.parse(await Bun.file(manifest).text());
  if (!isJsonObject(parsed) || typeof parsed.name !== "string") {
    throw new TypeError(`Invalid workspace package manifest: ${manifest}`);
  }
  return {
    name: parsed.name,
    path: normalizePath(relative(root, manifest)),
    dependencies: dependencyNames(parsed.dependencies),
    devDependencies: dependencyNames(parsed.devDependencies),
  };
};

const edgeDetail = (owner: WorkspaceManifest, kind: EdgeKind, target: string): string => {
  const edge = `${owner.name} ${kind} -> ${target}`;
  if (kind === "dependencies" && target === "@lando/core" && owner.name !== "@lando/core") {
    return `[PackageDagForbiddenRuntimeEdge] ${edge}. Remediation: Remove the runtime dependency on @lando/core and depend on an approved private seam or @lando/sdk contract instead.`;
  }
  return `[PackageDagUndeclaredEdge] ${edge}. Remediation: Declare ${target} in ${owner.name}'s ${kind} policy in WORKSPACE_EDGE_TABLE, or remove it from ${owner.path}.`;
};

const isAllowed = (targets: AllowedTargets, target: string): boolean =>
  targets === "workspace" || targets.includes(target);

const checkProgram = async (context: ProgramContext): Promise<void> => {
  const packages = await Promise.all(
    (await collectManifests(context.root)).map((manifest) => readWorkspaceManifest(manifest, context.root)),
  );
  const workspaceNames = new Set(packages.map((workspacePackage) => workspacePackage.name));

  for (const workspacePackage of packages) {
    const policy = WORKSPACE_EDGE_TABLE[workspacePackage.name];
    if (policy === undefined) {
      context.report(
        workspacePackage.path,
        1,
        `[PackageDagPackageDeclarationMissing] ${workspacePackage.name} has no workspace DAG declaration. Remediation: Add ${workspacePackage.name} to WORKSPACE_EDGE_TABLE in scripts/boundary/rules/package-dag.ts.`,
      );
      continue;
    }
    for (const kind of ["dependencies", "devDependencies"] as const) {
      for (const target of workspacePackage[kind]) {
        if (!workspaceNames.has(target) || isAllowed(policy[kind], target)) continue;
        context.report(workspacePackage.path, 1, edgeDetail(workspacePackage, kind, target));
      }
    }
  }
};

export const packageDagRule = {
  id: "package-dag",
  scope: PACKAGE_DAG_SCOPE,
  carveOuts: { files: [], prefixes: [] },
  passMessage: "Package DAG check passed.",
  failureHeadline: "Package DAG check failed. Fix package dependency direction:",
  onProgram: checkProgram,
} satisfies BoundaryRule;
