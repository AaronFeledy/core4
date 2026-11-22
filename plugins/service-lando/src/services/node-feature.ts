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
