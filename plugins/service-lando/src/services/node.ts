import { resolve } from "node:path";
import type { ServiceTypeError } from "@lando/sdk/errors";
import type { ServiceConfig } from "@lando/sdk/schema";
import type {
  ServiceFeatureContext,
  ServiceFeatureDefinition,
  ServiceType,
  ServiceTypeInput,
  ServiceTypeProjectFileDeclaration,
  ServiceTypeProjectFileInput,
  ServiceTypeResolution,
} from "@lando/sdk/services";
import { Effect, Schema } from "effect";
import {
  ServiceConfigIssue,
  rootIdentity,
  serviceFeatureApply,
  serviceFeatureValidateEffective,
  serviceTypeResolve,
} from "./_feature-helpers.ts";

import { type PackageEntry, normalizeNpmGlobals, shellSingleQuote } from "./_package-specs.ts";
import {
  type ListenerContract,
  applicationAuthority,
  assertListenerConfig,
  plannedPort,
  servicePortEndpoints,
} from "./_port-helpers.ts";
import { applyAuthoredProcessFields } from "./_process-helpers.ts";
import { resolveNodeInference } from "./node-inference.ts";
import {
  NODE_PACKAGE_MANAGER_STEP_ID,
  NodePackageManagerConfig,
  applyProvisionedGlobals,
  isProvisionedPackageManager,
  packageManagerConfigFor,
  packageManagerProvenance,
} from "./node-package-manager.ts";
import { resolveNodePackageManager } from "./node-package-manager-declaration.ts";
import {
  packageManagerBuildKeyInputs,
  packageManagerBuildStepCommand,
} from "./node-package-manager-install.ts";
import { NODE_ARTIFACTS, SUPPORTED_NODE_VERSIONS, type SupportedNodeVersion } from "./node-versions.ts";

export const NODE_FEATURE_ID = "service-lando.node" as const;
export const NODE_FEATURE_PRIORITY = 600;
export const NODE_GLOBALS_STEP_ID = "service-lando.node:globals" as const;

// The kernel drops default-disposition signals to PID 1, so the idle process handles them itself.
const DEFAULT_COMMAND = [
  "node",
  "-e",
  'process.on("SIGTERM",()=>process.exit(0));process.on("SIGINT",()=>process.exit(0));setInterval(()=>{},2147483647);',
] as const;
export const DEFAULT_PORT = 3000;
export const NODE_LISTENER = {
  port: DEFAULT_PORT,
  daemon: "Node.js",
  when: "All Node.js services; application-owned listener",
  variables: ["PORT"],
} as const satisfies ListenerContract;
export const APP_MOUNT_TARGET = "/app";

const PackageEntrySchema = Schema.Tuple([Schema.String, Schema.String]);

const NodeFeatureConfigSchema = Schema.Struct({
  version: Schema.String,
  packageManager: Schema.optionalKey(NodePackageManagerConfig),
  globals: Schema.Array(PackageEntrySchema),
});
type NodeFeatureConfig = typeof NodeFeatureConfigSchema.Type;

const REMEDIATION_VERSION = (requested: string): string =>
  `Set type to one of: ${SUPPORTED_NODE_VERSIONS.map((v) => `node:${v}`).join(", ")} (got node:${requested}).`;

const PROJECT_FILE_LIMIT = 1_048_576;

const validateVersion = (
  declaredType: string | undefined,
  fallback: SupportedNodeVersion,
): SupportedNodeVersion => {
  if (declaredType === undefined) return fallback;
  if (!declaredType.startsWith("node:")) return fallback;
  const version = declaredType.slice("node:".length);
  if ((SUPPORTED_NODE_VERSIONS as ReadonlyArray<string>).includes(version)) {
    return version as SupportedNodeVersion;
  }
  throw new ServiceConfigIssue(
    ["type"],
    `Unsupported Node version "${version}".`,
    REMEDIATION_VERSION(version),
  );
};

const artifactFor = (version: string): string =>
  Object.hasOwn(NODE_ARTIFACTS, version)
    ? NODE_ARTIFACTS[version as SupportedNodeVersion]
    : `node:${version}`;

// Node 22 and 24 images ship `yarn` as a Yarn 1 symlink and no pnpm; Node 26
// drops both that symlink and Corepack. --force lets authored globals replace a
// Yarn 1 stub instead of failing EEXIST.
const nodeGlobalsCommandFor = (entries: ReadonlyArray<PackageEntry>): string =>
  [
    "set -eux",
    [
      "npm install -g --force --no-fund --no-audit",
      ...entries.map(([name, version]) => shellSingleQuote(`${name}@${version}`)),
    ].join(" "),
  ].join(" && ");

const applyNodeFeature = (ctx: ServiceFeatureContext): void => {
  const service = ctx.normalizedConfig;
  const { version, packageManager, globals } = ctx.config as NodeFeatureConfig;
  const port = plannedPort(service, NODE_LISTENER);

  ctx.setArtifact({ kind: "ref", ref: service.image ?? artifactFor(version) });
  ctx.setCommand(service.command ?? [...DEFAULT_COMMAND]);
  ctx.addEnv("PORT", String(port));
  ctx.setListenerAuthority(applicationAuthority(NODE_LISTENER, port));
  applyAuthoredProcessFields(ctx, ["user"]);

  applyAuthoredProcessFields(ctx, ["entrypoint"]);
  if (globals.length > 0) {
    ctx.addBuildStep({
      id: NODE_GLOBALS_STEP_ID,
      phase: "build",
      command: nodeGlobalsCommandFor(globals),
      user: "root",
      buildKeyInputs: { globals },
    });
  }
  // Runs after the globals step so an authored global cannot shadow the launcher
  // Lando publishes. The launchers carry their own Corepack environment, so a
  // non-root `user:` runs the same exact release with no container-start work.
  if (packageManager !== undefined && isProvisionedPackageManager(packageManager.name)) {
    ctx.addBuildStep({
      id: NODE_PACKAGE_MANAGER_STEP_ID,
      phase: "build",
      command: packageManagerBuildStepCommand(packageManager),
      user: "root",
      buildKeyInputs: packageManagerBuildKeyInputs(packageManager),
    });
  }
};

export const nodeServiceFeature: ServiceFeatureDefinition = {
  id: NODE_FEATURE_ID,
  schema: NodeFeatureConfigSchema as Schema.Codec<unknown>,
  priority: NODE_FEATURE_PRIORITY,
  validateEffective: serviceFeatureValidateEffective(NODE_FEATURE_ID, (ctx) => {
    assertListenerConfig(ctx.normalizedConfig, NODE_LISTENER);
    return { handledServiceFields: [] };
  }),
  declareEndpoints: (ctx) =>
    Effect.sync(() =>
      servicePortEndpoints(ctx, { port: plannedPort(ctx.normalizedConfig, NODE_LISTENER), protocol: "http" }),
    ),
  apply: serviceFeatureApply(NODE_FEATURE_ID, "service-lando.node failed to apply", applyNodeFeature),
};

const normalizedService = (service: ServiceConfig, resolvedVersion: string): ServiceConfig => ({
  ...service,
  type: `node:${resolvedVersion}`,
});

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
    // A workspace package normally inherits packageManager from the monorepo
    // root, so the app-root manifest is a declared input only when the service
    // points elsewhere. At "." the entry above already is the app-root file.
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
    const globals = applyProvisionedGlobals(normalizeNpmGlobals(input.service.globals), packageManager);
    const files = projectFiles.map((file) => ({
      path: file.path,
      present: file.present,
      ...(file.present ? { sha256: file.sha256 } : {}),
    }));
    return {
      base: "lando" as const,
      normalizedConfig: normalizedService(input.service, selected.version),
      features: [
        {
          id: NODE_FEATURE_ID,
          config: {
            version: selected.version,
            globals,
            ...(packageManager === undefined
              ? {}
              : { packageManager: packageManagerConfigFor(packageManager) }),
          },
        },
        { id: "lando.app-mount", config: { target: APP_MOUNT_TARGET } },
      ],
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
          ...(packageManager === undefined
            ? {}
            : { packageManager: packageManagerProvenance(packageManager) }),
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
