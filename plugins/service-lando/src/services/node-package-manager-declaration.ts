import type { ServiceTypeProjectFileInput } from "@lando/sdk/services";
import { satisfies, valid, validRange } from "semver";

import { NodeInferenceError, readPackageJson } from "./node-inference.ts";
import {
  type NodePackageManagerName,
  type NodePackageManagerSelection,
  isProvisionedPackageManager,
} from "./node-package-manager.ts";
import {
  invalidSpec,
  requireManagerName,
  splitManagerVersion,
  splitSpec,
} from "./node-package-manager-spec.ts";

const DEV_MANAGER = ["devEngines", "packageManager"] as const;
const DEV_NAME = [...DEV_MANAGER, "name"] as const;
const DEV_VERSION = [...DEV_MANAGER, "version"] as const;
const DEV_ON_FAIL = [...DEV_MANAGER, "onFail"] as const;

const PACKAGE_JSON_PATH = /(?:^|[/\\])package\.json$/u;
const APP_ROOT_PACKAGE_JSON_PATH = /^package\.json$/u;

const invalidDevVersion = (sourcePath: string, exact: boolean): NodeInferenceError =>
  new NodeInferenceError(
    exact ? "The package manager must pin an exact version." : "Expected a valid version or semver range.",
    exact ? 'Use an exact version such as "9.15.0".' : 'Use a version or range such as "9.15.0" or "^9".',
    sourcePath,
    DEV_VERSION,
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

const parseTopLevelSpec = (sourcePath: string, raw: unknown): NodePackageManagerSelection => {
  const parsed = splitSpec(sourcePath, raw);
  if (isProvisionedPackageManager(parsed.name)) {
    // Exact versions only: the cache is keyed by the authored reference, and a
    // runtime range would need a registry lookup Lando refuses to perform.
    if (valid(parsed.version) !== parsed.version) throw invalidSpec(sourcePath, true);
  } else if (validRange(parsed.version) === null) {
    throw invalidSpec(sourcePath, false);
  }
  return {
    ...parsed,
    sourcePath,
    sourceField: "packageManager",
  };
};

interface DevEngineDeclaration {
  readonly name: NodePackageManagerName;
  readonly version: string;
  readonly integrity?: string;
  readonly range?: string;
  readonly onFail: "error" | "warn" | "ignore";
}

/** `undefined` means the object has no `packageManager` key at all. */
const parseDevEngines = (
  sourcePath: string,
  raw: unknown,
  requireVersion: boolean,
): DevEngineDeclaration | undefined => {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new NodeInferenceError(
      "Expected an object.",
      "Put the package manager declaration inside a devEngines object.",
      sourcePath,
      ["devEngines"],
    );
  }
  if (!Object.hasOwn(raw, "packageManager")) return undefined;
  const entry = Reflect.get(raw, "packageManager");
  if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
    throw new NodeInferenceError(
      "Expected a package manager object.",
      "Use an object with separate name and version fields.",
      sourcePath,
      DEV_MANAGER,
    );
  }

  const rawName: unknown = Reflect.get(entry, "name");
  if (typeof rawName !== "string" || rawName.length === 0 || rawName.includes("@")) {
    throw new NodeInferenceError(
      "Expected a non-empty manager name without a version.",
      'Use "pnpm", "yarn", "npm", or "bun".',
      sourcePath,
      DEV_NAME,
    );
  }
  const name = requireManagerName(sourcePath, DEV_NAME, rawName);

  const version: unknown = Reflect.get(entry, "version");
  const exact = requireVersion && isProvisionedPackageManager(name);
  if (version === undefined && exact) throw invalidDevVersion(sourcePath, exact);
  if (
    version !== undefined &&
    (typeof version !== "string" || version === "" || validRange(version) === null)
  ) {
    throw invalidDevVersion(sourcePath, exact);
  }

  const onFailRaw: unknown = Reflect.get(entry, "onFail");
  const onFail = onFailRaw === undefined ? "error" : onFailRaw;
  if (onFail !== "error" && onFail !== "warn" && onFail !== "ignore") {
    throw new NodeInferenceError(
      'Expected "error", "warn", or "ignore".',
      "Remove the option to use the default policy.",
      sourcePath,
      DEV_ON_FAIL,
    );
  }

  const parsed =
    version === undefined
      ? { version: "*", integrity: undefined }
      : splitManagerVersion(sourcePath, DEV_VERSION, version);
  return {
    name,
    version: parsed.version,
    ...(parsed.integrity === undefined ? {} : { integrity: parsed.integrity }),
    ...(version === undefined ? {} : { range: version.split("+")[0] ?? version }),
    onFail,
  };
};

const checkSecondaryDeclarations = (
  sourcePath: string,
  top: NodePackageManagerSelection,
  dev: DevEngineDeclaration,
): void => {
  if (dev.integrity !== undefined && top.integrity === undefined) {
    throw new NodeInferenceError(
      "The secondary integrity hash is ambiguous because the top-level pin has no hash.",
      "Move the integrity hash onto the winning packageManager spec.",
      sourcePath,
      DEV_VERSION,
    );
  }
  if (top.integrity !== undefined && dev.integrity !== undefined && top.integrity !== dev.integrity) {
    throw new NodeInferenceError(
      "The declarations have different integrity hashes.",
      "Keep one integrity hash on the winning packageManager spec.",
      sourcePath,
      ["packageManager"],
    );
  }
  if (dev.onFail !== "error") return;
  if (dev.name !== top.name) {
    throw new NodeInferenceError(
      `The declared manager "${dev.name}" conflicts with the top-level pin for "${top.name}".`,
      "Make both fields name the same manager, or remove devEngines.packageManager.",
      sourcePath,
      DEV_NAME,
    );
  }
  if (
    dev.range !== undefined &&
    validRange(dev.range) !== null &&
    valid(top.version) === top.version &&
    !satisfies(top.version, dev.range)
  ) {
    throw new NodeInferenceError(
      `The range "${dev.range}" does not allow the top-level pin ${top.name}@${top.version}.`,
      "Widen the range or choose a top-level pin it allows.",
      sourcePath,
      DEV_VERSION,
    );
  }
};

const parseManifest = (
  sourcePath: string,
  parsed: Readonly<Record<string, unknown>>,
): NodePackageManagerSelection | undefined => {
  const topLevel = Object.hasOwn(parsed, "packageManager")
    ? Reflect.get(parsed, "packageManager")
    : undefined;
  const devEngines = Object.hasOwn(parsed, "devEngines")
    ? parseDevEngines(sourcePath, Reflect.get(parsed, "devEngines"), topLevel === undefined)
    : undefined;

  if (topLevel !== undefined) {
    const top = parseTopLevelSpec(sourcePath, topLevel);
    if (devEngines !== undefined) checkSecondaryDeclarations(sourcePath, top, devEngines);
    return top;
  }
  if (devEngines === undefined) return undefined;

  if (isProvisionedPackageManager(devEngines.name) && valid(devEngines.version) !== devEngines.version) {
    throw invalidDevVersion(sourcePath, true);
  }
  return {
    name: devEngines.name,
    version: devEngines.version,
    ...(devEngines.integrity === undefined ? {} : { integrity: devEngines.integrity }),
    sourcePath,
    sourceField: "devEngines.packageManager",
  };
};

/**
 * Read the winning manager declaration from the nearest declaring manifest.
 * A nested package that declares nothing falls back to the monorepo root, which
 * is where workspaces normally keep `packageManager`. A malformed declaration
 * fails instead of silently deferring to a further file, and a recognised
 * `npm`/`bun` declaration stops the walk without provisioning anything.
 */
export const resolveNodePackageManager = (
  inputs: ReadonlyArray<ServiceTypeProjectFileInput>,
): NodePackageManagerSelection | undefined => {
  for (const input of packageJsonInputs(inputs)) {
    if (!input.present) continue;
    const parsed = readPackageJson(input);
    const selection = parseManifest(input.path, parsed);
    if (selection !== undefined) return selection;
  }
  return undefined;
};
