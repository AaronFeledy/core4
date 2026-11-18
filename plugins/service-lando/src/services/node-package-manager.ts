import { Schema } from "effect";

import { ServiceConfigIssue } from "./_feature-helpers.ts";
import type { PackageEntry } from "./_package-specs.ts";

export const NODE_PACKAGE_MANAGER_STEP_ID = "service-lando.node:package-manager" as const;

/** Bumped whenever the published launchers change shape; invalidates old plans. */
export const PACKAGE_MANAGER_LAUNCHER_REVISION = "host-npm-v1" as const;

/** Managers a manifest may name. `bun` and `npm` are recognised no-ops. */
export const NODE_PACKAGE_MANAGER_NAMES = ["yarn", "pnpm", "npm", "bun"] as const;
export type NodePackageManagerName = (typeof NODE_PACKAGE_MANAGER_NAMES)[number];

const PROVISIONED_NAMES: ReadonlySet<string> = new Set(["yarn", "pnpm"]);

export const isProvisionedPackageManager = (name: string): boolean => PROVISIONED_NAMES.has(name);

export const NodePackageManagerSourceField = Schema.Literals(["packageManager", "devEngines.packageManager"]);
export type NodePackageManagerSourceField = typeof NodePackageManagerSourceField.Type;

export const NodePackageManagerConfig = Schema.Struct({
  name: Schema.Literals(NODE_PACKAGE_MANAGER_NAMES),
  version: Schema.String,
  sourcePath: Schema.String,
  sourceField: NodePackageManagerSourceField,
  integrity: Schema.optionalKey(Schema.String),
  launcher: Schema.Literal(PACKAGE_MANAGER_LAUNCHER_REVISION),
});
export type NodePackageManagerConfig = typeof NodePackageManagerConfig.Type;

export interface NodePackageManagerSelection {
  readonly name: NodePackageManagerName;
  /** Exact for provisioned managers; the authored spec for `npm` and `bun`. */
  readonly version: string;
  readonly integrity?: string;
  /** App-root-relative path of the package.json that declared it. */
  readonly sourcePath: string;
  readonly sourceField: NodePackageManagerSourceField;
}

export const packageManagerConfigFor = (
  selection: NodePackageManagerSelection,
): NodePackageManagerConfig => ({
  name: selection.name,
  version: selection.version,
  sourcePath: selection.sourcePath,
  sourceField: selection.sourceField,
  ...(selection.integrity === undefined ? {} : { integrity: selection.integrity }),
  launcher: PACKAGE_MANAGER_LAUNCHER_REVISION,
});

/**
 * A `globals` entry for the selected manager is a second source of truth. An
 * identical exact version is redundant and dropped; any other spec is a
 * located error because the image would contain two installs.
 */
export const applyProvisionedGlobals = (
  globals: ReadonlyArray<PackageEntry>,
  selection: NodePackageManagerSelection | undefined,
): ReadonlyArray<PackageEntry> => {
  if (selection === undefined || !isProvisionedPackageManager(selection.name)) return globals;
  const entry = globals.find(([name]) => name === selection.name);
  if (entry === undefined) return globals;
  const [, version] = entry;
  if (version === selection.version) return globals.filter(([name]) => name !== selection.name);
  throw new ServiceConfigIssue(
    ["globals", selection.name],
    `globals installs ${selection.name}@${version}, but ${selection.sourcePath} ${selection.sourceField} pins ${selection.name}@${selection.version}.`,
    `Remove globals.${selection.name}; ${selection.sourceField} in ${selection.sourcePath} owns that version.`,
  );
};
