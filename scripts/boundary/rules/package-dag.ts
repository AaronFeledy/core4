import { relative } from "node:path";

import { collectManifests } from "../graph.ts";
import type { BoundaryRule, ProgramContext } from "../types.ts";
import {
  GENERATED_COMPOSITION_PREFIXES,
  WORKSPACE_EDGE_TABLE,
  type WorkspaceEdgeKind,
  type WorkspaceManifest,
  isWorkspaceTargetAllowed,
} from "./package-dag-policy.ts";
import { checkPackageSourceEdges } from "./package-dag-source.ts";

const PACKAGE_DAG_SCOPE = {
  roots: ["."],
  extensions: [".json", ".ts", ".tsx", ".mts", ".cts"],
  excludeDirNames: [".git", ".local", ".codegraph", "node_modules", "dist"],
  excludePathSegments: ["test"],
  excludeTestFiles: true,
} as const;

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
    path: relative(root, manifest).replaceAll("\\", "/"),
    dependencies: dependencyNames(parsed.dependencies),
    devDependencies: dependencyNames(parsed.devDependencies),
  };
};

const edgeDetail = (owner: WorkspaceManifest, kind: WorkspaceEdgeKind, target: string): string => {
  const edge = `${owner.name} ${kind} -> ${target}`;
  if (kind === "dependencies" && target === "@lando/core" && owner.name !== "@lando/core") {
    return `[PackageDagForbiddenRuntimeEdge] ${edge}. Remediation: Remove the runtime dependency on @lando/core and depend on an approved private seam or @lando/sdk contract instead.`;
  }
  return `[PackageDagUndeclaredEdge] ${edge}. Remediation: Declare ${target} in ${owner.name}'s ${kind} policy in WORKSPACE_EDGE_TABLE, or remove it from ${owner.path}.`;
};

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
        `[PackageDagPackageDeclarationMissing] ${workspacePackage.name} has no workspace DAG declaration. Remediation: Add ${workspacePackage.name} to WORKSPACE_EDGE_TABLE in scripts/boundary/rules/package-dag-policy.ts.`,
      );
      continue;
    }
    for (const kind of ["dependencies", "devDependencies"] as const) {
      for (const target of workspacePackage[kind]) {
        if (!workspaceNames.has(target) || isWorkspaceTargetAllowed(policy[kind], target)) continue;
        context.report(workspacePackage.path, 1, edgeDetail(workspacePackage, kind, target));
      }
    }
  }

  await checkPackageSourceEdges(context, packages);
};

export const packageDagRule = {
  id: "package-dag",
  scope: PACKAGE_DAG_SCOPE,
  carveOuts: { files: [], prefixes: GENERATED_COMPOSITION_PREFIXES },
  passMessage: "Package DAG check passed.",
  failureHeadline: "Package DAG check failed. Fix package dependency direction:",
  onProgram: checkProgram,
} satisfies BoundaryRule;
