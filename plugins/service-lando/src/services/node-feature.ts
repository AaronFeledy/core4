import { PortablePath, type ServiceConfig, landoCacheStoreName, sameImageReference } from "@lando/sdk/schema";
import type { ServiceFeatureContext, ServiceFeatureDefinition } from "@lando/sdk/services";
import { Effect, Schema } from "effect";
import { serviceFeatureApply, serviceFeatureValidateEffective } from "./_feature-helpers.ts";
import { type PackageEntry, shellSingleQuote } from "./_package-specs.ts";
import {
  type ListenerContract,
  applicationAuthority,
  assertListenerConfig,
  primaryPortSelector,
  servicePortEndpoints,
} from "./_port-helpers.ts";
import { applyAuthoredProcessFields } from "./_process-helpers.ts";
import { NodePackageManagerConfig, isProvisionedPackageManager } from "./node-package-manager.ts";
import { packageManagerBuildStep } from "./node-package-manager-install.ts";
import { NODE_ARTIFACTS, SUPPORTED_NODE_VERSIONS } from "./node-versions.ts";

export const NODE_FEATURE_ID = "service-lando.node" as const;
export const NODE_FEATURE_PRIORITY = 600;
export const NODE_GLOBALS_STEP_ID = "service-lando.node:globals" as const;
export const NODE_PACKAGE_CACHE_STEP_ID = "service-lando.node:package-cache" as const;
export const NODE_PACKAGE_CACHE_KEY = "node-packages" as const;
export const NODE_PACKAGE_CACHE_TARGET = "/var/lib/lando/node-cache" as const;
export const NODE_PACKAGE_CACHE_PATHS = {
  npm: `${NODE_PACKAGE_CACHE_TARGET}/npm`,
  pnpm: `${NODE_PACKAGE_CACHE_TARGET}/pnpm`,
  yarn: `${NODE_PACKAGE_CACHE_TARGET}/yarn`,
  yarnGlobal: `${NODE_PACKAGE_CACHE_TARGET}/yarn-global`,
} as const;
export const NODE_PACKAGE_CACHE = {
  store: landoCacheStoreName(NODE_PACKAGE_CACHE_KEY),
  target: PortablePath.make(NODE_PACKAGE_CACHE_TARGET),
  readOnly: false,
  kind: "cache",
  key: NODE_PACKAGE_CACHE_KEY,
} as const;
const NODE_PACKAGE_CACHE_DIRS = Object.values(NODE_PACKAGE_CACHE_PATHS);
export const NODE_PACKAGE_CACHE_PREPARE = [
  "set -eu",
  ["mkdir -p", ...NODE_PACKAGE_CACHE_DIRS].join(" "),
  ["chmod 1777", NODE_PACKAGE_CACHE_TARGET, ...NODE_PACKAGE_CACHE_DIRS].join(" "),
].join("; ");

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
export const nodePlannedPort = primaryPortSelector(NODE_LISTENER);

const NodeFeatureConfigSchema = Schema.Struct({
  version: Schema.String,
  packageManager: Schema.optionalKey(NodePackageManagerConfig),
  globals: Schema.Array(Schema.Tuple([Schema.String, Schema.String])),
});
type NodeFeatureConfig = typeof NodeFeatureConfigSchema.Type;

export const artifactFor = (version: string): string => {
  const supported = SUPPORTED_NODE_VERSIONS.find((candidate) => candidate === version);
  return supported === undefined ? `node:${version}` : NODE_ARTIFACTS[supported];
};

/** Catalog image plus additive build; a custom image or replacement Compose build owns the toolchain. */
export const ownsNodeToolchain = (
  { image, build }: Pick<ServiceConfig, "image" | "build">,
  version: string,
): boolean =>
  (build === undefined || !("context" in build)) &&
  (image === undefined || sameImageReference(image, artifactFor(version)));

export const usesNodePackageCache = (
  service: Pick<ServiceConfig, "image" | "build" | "packageCache">,
  version: string,
): boolean => ownsNodeToolchain(service, version) && service.packageCache !== false;

const unsetEnvironment = (environment: ServiceConfig["environment"], name: string): boolean =>
  environment === undefined || !Object.hasOwn(environment, name);

export const nodePackageCacheEnvironment = (
  environment: ServiceConfig["environment"],
  packageManager: NodePackageManagerConfig | undefined,
): Record<string, string> => {
  const assigned: Record<string, string> = {};
  const set = (name: string, value: string): void => {
    if (unsetEnvironment(environment, name)) assigned[name] = value;
  };
  set("npm_config_cache", NODE_PACKAGE_CACHE_PATHS.npm);
  if (packageManager?.name === "pnpm") {
    const major = Number(packageManager.version.split(".")[0]);
    set(major >= 11 ? "pnpm_config_store_dir" : "npm_config_store_dir", NODE_PACKAGE_CACHE_PATHS.pnpm);
  }
  if (packageManager?.name === "yarn") {
    const major = Number(packageManager.version.split(".")[0]);
    set(
      major >= 2 ? "YARN_GLOBAL_FOLDER" : "YARN_CACHE_FOLDER",
      major >= 2 ? NODE_PACKAGE_CACHE_PATHS.yarnGlobal : NODE_PACKAGE_CACHE_PATHS.yarn,
    );
  }
  return assigned;
};

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
  const port = nodePlannedPort(service);

  ctx.setArtifact({ kind: "ref", ref: service.image ?? artifactFor(version) });
  ctx.setCommand(service.command ?? [...DEFAULT_COMMAND]);
  ctx.addEnv("PORT", String(port));
  ctx.setListenerAuthority(applicationAuthority(NODE_LISTENER, port, service));
  applyAuthoredProcessFields(ctx, ["user", "entrypoint"]);
  if (usesNodePackageCache(service, version)) {
    const { store, target, readOnly } = NODE_PACKAGE_CACHE;
    ctx.addStorage({ store, target, readOnly });
    const cacheEnv = nodePackageCacheEnvironment(service.environment, packageManager);
    for (const [name, value] of Object.entries(cacheEnv)) ctx.addEnv(name, value);
    ctx.addBuildStep({
      id: NODE_PACKAGE_CACHE_STEP_ID,
      phase: "build",
      user: "root",
      command: ["sh", "-c", NODE_PACKAGE_CACHE_PREPARE],
    });
  }
  if (globals.length > 0) {
    ctx.addBuildStep({
      id: NODE_GLOBALS_STEP_ID,
      phase: "build",
      command: nodeGlobalsCommandFor(globals),
      user: "root",
      buildKeyInputs: { globals },
    });
  }
  if (packageManager !== undefined && isProvisionedPackageManager(packageManager.name)) {
    ctx.addBuildStep(packageManagerBuildStep(packageManager));
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
      servicePortEndpoints(ctx, { port: nodePlannedPort(ctx.normalizedConfig), protocol: "http" }),
    ),
  apply: serviceFeatureApply(NODE_FEATURE_ID, "service-lando.node failed to apply", applyNodeFeature),
};
