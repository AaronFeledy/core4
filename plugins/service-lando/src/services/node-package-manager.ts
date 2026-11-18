/**
 * Package-manager provisioning for catalog-owned `node` service types.
 *
 * A project's manifest names the tool its authors use, in `packageManager` or,
 * when that field is absent, `devEngines.packageManager`. The official Node
 * images disagree about what they ship: Node 22 and 24 carry a Yarn 1 symlink
 * plus a bundled Corepack, Node 26 carries neither, and early Node 22 images
 * bundle Corepack releases that no longer verify npm registry signatures.
 * Rather than depending on whatever the image happens to hold, the artifact
 * build installs one committed Corepack pin privately, verifies the downloaded
 * tarball against its pin, seeds the declared release into a fresh image cache,
 * and publishes launchers that invoke that exact descriptor with no manifest
 * walk, so the runtime shim works offline and cannot drift to another manifest.
 *
 * The pin file records the release and the SHA-256 of its npm registry
 * tarball: `curl -fsSL https://registry.npmjs.org/corepack/-/corepack-<version>.tgz
 * | sha256sum`. Corepack 0.34.7 is the last release whose proxy support reads
 * the conventional HTTP(S)_PROXY variables; 0.35.0+ requires
 * NODE_USE_ENV_PROXY, which regresses corporate-proxy builds.
 */

import { Schema } from "effect";

import { ServiceConfigIssue } from "./_feature-helpers.ts";
import type { PackageEntry } from "./_package-specs.ts";
import corepackPins from "./node-corepack-pins.json" with { type: "json" };

export const NODE_PACKAGE_MANAGER_STEP_ID = "service-lando.node:package-manager" as const;

/** Image-wide Corepack cache; world-readable so any service user can run the launcher. */
export const COREPACK_HOME = "/usr/local/share/corepack" as const;

/**
 * Root-owned private Corepack install. It deliberately has no global bin links:
 * a global install would replace the other manager family's launchers, an
 * authored `globals` install, or the catalog Yarn 1 symlinks.
 */
export const COREPACK_PREFIX = "/usr/local/lib/corepack" as const;

/** Bumped whenever the published launchers change shape; invalidates old plans. */
export const PACKAGE_MANAGER_LAUNCHER_REVISION = "exact-private-v1" as const;

const CorepackPin = Schema.Struct({
  version: Schema.String,
  sha256: Schema.String.pipe(Schema.check(Schema.isPattern(/^[0-9a-f]{64}$/u))),
});

const CorepackPinManifest = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  corepack: CorepackPin,
});

export type CorepackPin = typeof CorepackPin.Type;

/** The committed Corepack release the node build step installs and verifies. */
export const COREPACK_PIN: CorepackPin = Schema.decodeUnknownSync(CorepackPinManifest)(corepackPins).corepack;

/** Managers a manifest may name. `bun` and `npm` are recognised no-ops. */
export const NODE_PACKAGE_MANAGER_NAMES = ["yarn", "pnpm", "npm", "bun"] as const;
export type NodePackageManagerName = (typeof NODE_PACKAGE_MANAGER_NAMES)[number];

const PROVISIONED_NAMES: ReadonlySet<string> = new Set(["yarn", "pnpm"]);

/** Corepack can provide these; `npm` and `bun` stay with the image or project. */
export const isProvisionedPackageManager = (name: string): boolean => PROVISIONED_NAMES.has(name);

export const NodePackageManagerSourceField = Schema.Literals(["packageManager", "devEngines.packageManager"]);
export type NodePackageManagerSourceField = typeof NodePackageManagerSourceField.Type;

export const NodePackageManagerConfig = Schema.Struct({
  name: Schema.Literals(NODE_PACKAGE_MANAGER_NAMES),
  version: Schema.String,
  sourcePath: Schema.String,
  sourceField: NodePackageManagerSourceField,
  integrity: Schema.optionalKey(Schema.String),
  corepack: CorepackPin,
  launcher: Schema.Literal(PACKAGE_MANAGER_LAUNCHER_REVISION),
});
export type NodePackageManagerConfig = typeof NodePackageManagerConfig.Type;

export interface NodePackageManagerSelection {
  readonly name: NodePackageManagerName;
  /** Exact for provisioned managers; the authored spec for `npm` and `bun`. */
  readonly version: string;
  /** Authored `<algo>.<hex>` integrity, passed through to Corepack for verification. */
  readonly integrity?: string;
  /** App-root-relative path of the package.json that declared it. */
  readonly sourcePath: string;
  readonly sourceField: NodePackageManagerSourceField;
}

export const packageManagerSpec = (
  selection: NodePackageManagerConfig,
  binary: NodePackageManagerName | "pnpx" = selection.name,
): string =>
  `${binary}@${selection.version}${selection.integrity === undefined ? "" : `+${selection.integrity}`}`;

/** Provenance written to `metadata.node`; deliberately free of file contents. */
export const packageManagerProvenance = (
  selection: NodePackageManagerSelection,
): {
  readonly name: string;
  readonly version: string;
  readonly sourcePath: string;
  readonly sourceField: NodePackageManagerSourceField;
} => ({
  name: selection.name,
  version: selection.version,
  sourcePath: selection.sourcePath,
  sourceField: selection.sourceField,
});

export const packageManagerConfigFor = (
  selection: NodePackageManagerSelection,
): NodePackageManagerConfig => ({
  name: selection.name,
  version: selection.version,
  sourcePath: selection.sourcePath,
  sourceField: selection.sourceField,
  ...(selection.integrity === undefined ? {} : { integrity: selection.integrity }),
  corepack: { version: COREPACK_PIN.version, sha256: COREPACK_PIN.sha256 },
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
