/**
 * Package-manager provisioning for the bare `node` service type.
 *
 * A project's `packageManager` field names the tool its authors use. The
 * official Node images disagree about what they ship: Node 22 and 24 carry a
 * Yarn 1 symlink plus a bundled Corepack, Node 26 carries neither, and early
 * Node 22 images bundle Corepack releases that no longer verify npm registry
 * signatures. Rather than depending on whatever the image happens to hold,
 * the artifact build installs one committed Corepack pin, verifies the
 * downloaded tarball against its pin before installing it, and caches the
 * exact package manager version the project declares, so the runtime shim
 * works offline at container start.
 *
 * The pin file records the release and the SHA-256 of its npm registry
 * tarball: `curl -fsSL https://registry.npmjs.org/corepack/-/corepack-<version>.tgz
 * | sha256sum`. Corepack 0.34.7 is the last release whose proxy support reads
 * the conventional HTTP(S)_PROXY variables; 0.35.0+ requires
 * NODE_USE_ENV_PROXY, which regresses corporate-proxy builds.
 */

import type { ServiceTypeProjectFileInput } from "@lando/sdk/services";
import { Schema } from "effect";
import { valid } from "semver";

import { shellSingleQuote } from "./_package-specs.ts";
import corepackPins from "./node-corepack-pins.json" with { type: "json" };
import { NodeInferenceError, readPackageJson } from "./node-inference.ts";

export const NODE_PACKAGE_MANAGER_STEP_ID = "service-lando.node:package-manager" as const;

/** Image-wide Corepack cache; world-readable so a non-root service user can run the shim. */
export const COREPACK_HOME = "/usr/local/share/corepack" as const;

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

export const NODE_PACKAGE_MANAGER_NAMES = ["yarn", "pnpm", "npm"] as const;
export type NodePackageManagerName = (typeof NODE_PACKAGE_MANAGER_NAMES)[number];

const PROVISIONED_NAMES: ReadonlySet<string> = new Set(["yarn", "pnpm"]);

/** Corepack can provide these; `npm` stays with the image. */
export const isProvisionedPackageManager = (name: string): boolean => PROVISIONED_NAMES.has(name);

export const NodePackageManagerConfig = Schema.Struct({
  name: Schema.Literals(NODE_PACKAGE_MANAGER_NAMES),
  version: Schema.String,
  sourcePath: Schema.String,
  integrity: Schema.optionalKey(Schema.String),
});
export type NodePackageManagerConfig = typeof NodePackageManagerConfig.Type;

export interface NodePackageManagerSelection {
  readonly name: NodePackageManagerName;
  /** Exact semver, without the `+<algo>.<hex>` integrity suffix. */
  readonly version: string;
  /** Authored `<algo>.<hex>` integrity, passed through to Corepack for verification. */
  readonly integrity?: string;
  /** App-root-relative path of the package.json that declared it. */
  readonly sourcePath: string;
}

const PACKAGE_JSON_PATH = /(?:^|[/\\])package\.json$/u;
const APP_ROOT_PACKAGE_JSON_PATH = /^package\.json$/u;
const PACKAGE_MANAGER_NAME_PATTERN = /^[a-z][a-z0-9._-]*$/u;

const INTEGRITY_HEX_LENGTH: Readonly<Record<string, number>> = {
  sha224: 56,
  sha256: 64,
  sha384: 96,
  sha512: 128,
};

const invalidSpec = (sourcePath: string, value: unknown): NodeInferenceError =>
  new NodeInferenceError(
    `packageManager in ${sourcePath} is not a valid package manager spec: ${JSON.stringify(value)}.`,
    'Use an exact "<name>@<version>" spec such as "yarn@4.5.3" or "pnpm@9.15.0+sha512.<hex>".',
    sourcePath,
  );

const unsupportedName = (sourcePath: string, name: string): NodeInferenceError =>
  new NodeInferenceError(
    `packageManager in ${sourcePath} names "${name}", which Lando cannot provision.`,
    `Install ${name} through globals, or use an explicit node:<version> type with a custom image; package.json packageManager provisions yarn, pnpm, or npm.`,
    sourcePath,
  );

/** The nearest declared package.json wins: a nested package root first, the app root last. */
const packageJsonInputs = (
  inputs: ReadonlyArray<ServiceTypeProjectFileInput>,
): ReadonlyArray<ServiceTypeProjectFileInput> => {
  const declared = inputs.filter((input) => PACKAGE_JSON_PATH.test(input.path));
  return [
    ...declared.filter((input) => !APP_ROOT_PACKAGE_JSON_PATH.test(input.path)),
    ...declared.filter((input) => APP_ROOT_PACKAGE_JSON_PATH.test(input.path)),
  ];
};

const parseIntegrity = (sourcePath: string, value: unknown, build: string): string => {
  const match = /^(sha224|sha256|sha384|sha512)\.([0-9a-f]+)$/u.exec(build);
  if (match === null) throw invalidSpec(sourcePath, value);
  const algorithm = match[1] ?? "";
  const hex = match[2] ?? "";
  if (INTEGRITY_HEX_LENGTH[algorithm] !== hex.length) throw invalidSpec(sourcePath, value);
  return build;
};

const parsePackageManagerSpec = (sourcePath: string, raw: unknown): NodePackageManagerSelection => {
  if (typeof raw !== "string") {
    throw new NodeInferenceError(
      `packageManager in ${sourcePath} must be a string.`,
      'Set packageManager to an exact "<name>@<version>" spec such as "yarn@4.5.3".',
      sourcePath,
    );
  }
  const at = raw.indexOf("@");
  if (at <= 0 || at === raw.length - 1) throw invalidSpec(sourcePath, raw);
  const name = raw.slice(0, at);
  if (!PACKAGE_MANAGER_NAME_PATTERN.test(name)) throw invalidSpec(sourcePath, raw);
  if (!(NODE_PACKAGE_MANAGER_NAMES as ReadonlyArray<string>).includes(name)) {
    throw unsupportedName(sourcePath, name);
  }

  const parts = raw.slice(at + 1).split("+");
  if (parts.length > 2) throw invalidSpec(sourcePath, raw);
  const [versionText = "", build] = parts;
  const version = valid(versionText);
  // Reject anything semver would normalize (leading `v`, stray whitespace): the
  // build caches `corepack install -g <spec>` under the authored reference, and
  // a runtime lookup with a different spelling would miss the cache.
  if (version === null || version !== versionText) throw invalidSpec(sourcePath, raw);
  const integrity = build === undefined ? undefined : parseIntegrity(sourcePath, raw, build);

  return {
    name: name as NodePackageManagerName,
    version,
    ...(integrity === undefined ? {} : { integrity }),
    sourcePath,
  };
};

/**
 * Read `packageManager` from the nearest declaring package.json. A nested
 * package that omits the field falls back to the monorepo root, which is where
 * workspaces normally keep it. A malformed declaration fails instead of
 * silently deferring to a further file.
 */
export const resolveNodePackageManager = (
  inputs: ReadonlyArray<ServiceTypeProjectFileInput>,
): NodePackageManagerSelection | undefined => {
  for (const input of packageJsonInputs(inputs)) {
    if (!input.present) continue;
    const value = Reflect.get(readPackageJson(input), "packageManager");
    if (value === undefined) continue;
    return parsePackageManagerSpec(input.path, value);
  }
  return undefined;
};

/** The exact spec Corepack installs, including the authored integrity when present. */
export const packageManagerSpec = (selection: NodePackageManagerConfig): string =>
  `${selection.name}@${selection.version}${selection.integrity === undefined ? "" : `+${selection.integrity}`}`;

/** Provenance written to `metadata.node`; deliberately free of file contents. */
export const packageManagerProvenance = (
  selection: NodePackageManagerSelection,
): { readonly name: string; readonly version: string; readonly sourcePath: string } => ({
  name: selection.name,
  version: selection.version,
  sourcePath: selection.sourcePath,
});

export const packageManagerConfigFor = (
  selection: NodePackageManagerSelection,
): NodePackageManagerConfig => ({
  name: selection.name,
  version: selection.version,
  sourcePath: selection.sourcePath,
  ...(selection.integrity === undefined ? {} : { integrity: selection.integrity }),
});

/**
 * The immutable identity of one provisioning step. The command below already
 * embeds these values; carrying them as inputs keeps the intent readable in
 * the build key and pins the Corepack release the artifact depends on.
 */
export const packageManagerBuildKeyInputs = (
  selection: NodePackageManagerConfig,
): Readonly<Record<string, unknown>> => ({
  packageManager: {
    name: selection.name,
    version: selection.version,
    ...(selection.integrity === undefined ? {} : { integrity: selection.integrity }),
  },
  corepack: { version: COREPACK_PIN.version, sha256: COREPACK_PIN.sha256 },
});

/**
 * One artifact-phase command: fetch Corepack with the image's npm (so the
 * registry, proxy, and CA settings configured for npm apply), verify the pinned
 * tarball digest before installing it, then replace any
 * image-provided shim (Node 22/24 symlink Yarn 1 into /opt) and cache the
 * declared package manager version under COREPACK_HOME.
 */
export const packageManagerBuildStepCommand = (selection: NodePackageManagerConfig): string => {
  const tarball = `corepack-${COREPACK_PIN.version}.tgz`;
  return [
    "set -eux",
    `export COREPACK_HOME=${shellSingleQuote(COREPACK_HOME)} COREPACK_ENABLE_DOWNLOAD_PROMPT=0`,
    `mkdir -p ${shellSingleQuote(COREPACK_HOME)}`,
    'PACK_DIR="$(mktemp -d)"',
    'cd "$PACK_DIR"',
    `npm pack corepack@${COREPACK_PIN.version}`,
    `printf '%s  %s\\n' ${shellSingleQuote(COREPACK_PIN.sha256)} ${shellSingleQuote(tarball)} | sha256sum -c -`,
    `npm install -g --force --no-fund --no-audit ${shellSingleQuote(`./${tarball}`)}`,
    `corepack enable --install-directory /usr/local/bin ${shellSingleQuote(selection.name)}`,
    `corepack install -g ${shellSingleQuote(packageManagerSpec(selection))}`,
    `chmod -R a+rX ${shellSingleQuote(COREPACK_HOME)}`,
    "cd /",
    'rm -rf "$PACK_DIR"',
  ].join(" && ");
};
