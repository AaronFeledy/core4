import { resolve } from "node:path";
import type { ServiceTypeError } from "@lando/sdk/errors";
import type { ServiceConfig } from "@lando/sdk/schema";
import type {
  ServiceType,
  ServiceTypeInput,
  ServiceTypeProjectFileDeclaration,
  ServiceTypeProjectFileInput,
  ServiceTypeResolution,
} from "@lando/sdk/services";
import { type Effect, Schema } from "effect";
import { ServiceConfigIssue, rootIdentity, serviceTypeResolve } from "./_feature-helpers.ts";
import { normalizeNpmGlobals } from "./_package-specs.ts";
import { NODE_FEATURE_ID, artifactFor } from "./node-feature.ts";
import { resolveNodeInference } from "./node-inference.ts";
import { applyProvisionedGlobals, packageManagerConfigFor } from "./node-package-manager.ts";
import { resolveNodePackageManager } from "./node-package-manager-declaration.ts";
import { validatePackageManagerDistribution } from "./node-package-manager-install.ts";
import { nodeManagerTooling } from "./node-tooling.ts";
import { NODE_ARTIFACTS, SUPPORTED_NODE_VERSIONS, type SupportedNodeVersion } from "./node-versions.ts";

export {
  DEFAULT_PORT,
  NODE_FEATURE_ID,
  NODE_FEATURE_PRIORITY,
  NODE_GLOBALS_STEP_ID,
  NODE_LISTENER,
  nodeServiceFeature,
} from "./node-feature.ts";
export const APP_MOUNT_TARGET = "/app";

const REMEDIATION_VERSION = (requested: string): string =>
  `Set type to one of: ${SUPPORTED_NODE_VERSIONS.map((v) => `node:${v}`).join(", ")} (got node:${requested}).`;

const PROJECT_FILE_LIMIT = 1_048_576;

const validateVersion = (
  declaredType: string | undefined,
  fallback: SupportedNodeVersion,
): SupportedNodeVersion => {
  if (!declaredType?.startsWith("node:")) return fallback;
  const version = declaredType.slice("node:".length);
  const supported = SUPPORTED_NODE_VERSIONS.find((candidate) => candidate === version);
  if (supported !== undefined) return supported;
  throw new ServiceConfigIssue(
    ["type"],
    `Unsupported Node version "${version}".`,
    REMEDIATION_VERSION(version),
  );
};

/** Version inputs are declared only for bare `node`; every catalog type reads manifests for the manager. */
const nodeProjectFiles = (
  service: ServiceConfig,
  includeVersionInputs: boolean,
): ReadonlyArray<ServiceTypeProjectFileDeclaration> => {
  const packageRoot = service.packageRoot ?? ".";
  const prefix = packageRoot === "." ? "" : `${packageRoot}/`;
  return [
    ...(includeVersionInputs ? [{ path: `${prefix}.nvmrc`, maxBytes: PROJECT_FILE_LIMIT }] : []),
    { path: `${prefix}package.json`, maxBytes: PROJECT_FILE_LIMIT },
    // A nested package can inherit its workspace root's manager.
    ...(packageRoot === "." ? [] : [{ path: "package.json", maxBytes: PROJECT_FILE_LIMIT }]),
  ];
};

type NodeVersionSelection = {
  readonly version: string;
  readonly inference?: ReturnType<typeof resolveNodeInference>;
};

const resolveCatalogNode = (
  serviceType: string,
  input: ServiceTypeInput,
  selectVersion: (files: ReadonlyArray<ServiceTypeProjectFileInput>) => NodeVersionSelection,
): Effect.Effect<ServiceTypeResolution, ServiceTypeError> =>
  serviceTypeResolve(serviceType, "Failed to resolve a Node service.", () => {
    const projectFiles = input.projectFiles ?? [];
    const selected = selectVersion(projectFiles);
    const packageManager = resolveNodePackageManager(projectFiles);
    if (packageManager !== undefined) validatePackageManagerDistribution(packageManager);
    const packageManagerConfig =
      packageManager === undefined ? undefined : packageManagerConfigFor(packageManager);
    // The planner supplies no candidates when the author owns the image/build.
    const catalogOwned = projectFiles.length > 0;
    const globals = applyProvisionedGlobals(normalizeNpmGlobals(input.service.globals), packageManager);
    const files = projectFiles.map((file) => ({
      path: file.path,
      present: file.present,
      ...(file.present ? { sha256: file.sha256 } : {}),
    }));
    return {
      base: "lando" as const,
      normalizedConfig: { ...input.service, type: `node:${selected.version}` },
      features: [
        {
          id: NODE_FEATURE_ID,
          config: {
            version: selected.version,
            globals,
            ...(packageManagerConfig === undefined ? {} : { packageManager: packageManagerConfig }),
          },
        },
        { id: "lando.app-mount", config: { target: APP_MOUNT_TARGET } },
      ],
      ...(catalogOwned ? { tooling: nodeManagerTooling(input.name, packageManager?.name) } : {}),
      metadata: {
        node: {
          ...(selected.inference === undefined
            ? {}
            : {
                sourcePath: selected.inference.sourcePath,
                normalizedConstraint: selected.inference.normalizedConstraint,
              }),
          artifact: artifactFor(selected.version),
          files,
          ...(catalogOwned ? { packageManager: packageManagerConfig ?? null } : {}),
        },
      },
    };
  });

const makeNodeServiceType = (version: SupportedNodeVersion): ServiceType => ({
  id: `node:${version}`,
  name: `node:${version}`,
  base: "lando",
  versions: SUPPORTED_NODE_VERSIONS,
  artifacts: NODE_ARTIFACTS,
  identity: rootIdentity({ node: "/home/node" }),
  schema: Schema.Unknown,
  projectFiles: (service) => nodeProjectFiles(service, false),
  resolve: (input) =>
    resolveCatalogNode(`node:${version}`, input, () => ({
      version: validateVersion(input.service.type, version),
    })),
});

export const nodeLtsServiceType: ServiceType = makeNodeServiceType("lts");
export const node22ServiceType: ServiceType = makeNodeServiceType("22");
export const node24ServiceType: ServiceType = makeNodeServiceType("24");
export const node26ServiceType: ServiceType = makeNodeServiceType("26");

export const nodeServiceType: ServiceType = {
  id: "node",
  name: "node",
  base: "lando",
  identity: rootIdentity({ node: "/home/node" }),
  schema: Schema.Unknown,
  projectFiles: (service) => nodeProjectFiles(service, true),
  resolve: (input) =>
    resolveCatalogNode("node", input, (files) => {
      // The app-root manifest is a packageManager fallback only; a nested
      // packageRoot must never inherit the root package's Node engines.
      const inferenceFiles =
        resolve(input.appRoot, input.service.packageRoot ?? ".") === resolve(input.appRoot)
          ? files
          : files.filter((file) => file.path !== "package.json");
      const inference = resolveNodeInference(inferenceFiles);
      return { version: inference.artifact.slice("node:".length), inference };
    }),
};
