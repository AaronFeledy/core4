import type { ServiceConfig } from "@lando/sdk/schema";
import type { ServiceFeatureContext, ServiceFeatureDefinition, ServiceType } from "@lando/sdk/services";
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

const NodeFeatureConfigSchema = Schema.Struct({
  version: Schema.String,
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
  const { version } = ctx.config as NodeFeatureConfig;
  const port = plannedPort(service, NODE_LISTENER);

  ctx.setArtifact({ kind: "ref", ref: service.image ?? artifactFor(version) });
  ctx.setCommand(service.command ?? [...DEFAULT_COMMAND]);
  ctx.addEnv("PORT", String(port));
  ctx.setListenerAuthority(applicationAuthority(NODE_LISTENER, port));
  applyAuthoredProcessFields(ctx, ["user"]);

  applyAuthoredProcessFields(ctx, ["entrypoint"]);
  const globals = normalizeNpmGlobals(service.globals);
  if (globals.length > 0) {
    ctx.addBuildStep({
      id: NODE_GLOBALS_STEP_ID,
      phase: "build",
      command: nodeGlobalsCommandFor(globals),
      user: "root",
      buildKeyInputs: { globals },
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

const makeNodeServiceType = (version: SupportedNodeVersion): ServiceType => ({
  id: `node:${version}`,
  name: `node:${version}`,
  base: "lando",
  versions: SUPPORTED_NODE_VERSIONS,
  artifacts: NODE_ARTIFACTS,
  identity: rootIdentity({ node: "/home/node" }),
  schema: Schema.Unknown,
  resolve: (input) =>
    serviceTypeResolve(`node:${version}`, `Failed to resolve node:${version}`, () => {
      const resolvedVersion = validateVersion(input.service.type, version);
      normalizeNpmGlobals(input.service.globals);

      return {
        base: "lando" as const,
        normalizedConfig: normalizedService(input.service, resolvedVersion),
        features: [
          { id: NODE_FEATURE_ID, config: { version: resolvedVersion } },
          {
            id: "lando.app-mount",
            config: { target: APP_MOUNT_TARGET },
          },
        ],
      };
    }),
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
  projectFiles: (service) => {
    const packageRoot = service.packageRoot ?? ".";
    const prefix = packageRoot === "." ? "" : `${packageRoot}/`;
    return [
      { path: `${prefix}.nvmrc`, maxBytes: PROJECT_FILE_LIMIT },
      { path: `${prefix}package.json`, maxBytes: PROJECT_FILE_LIMIT },
    ];
  },
  resolve: (input) =>
    serviceTypeResolve("node", "Failed to infer a Node version.", () => {
      const inference = resolveNodeInference(input.projectFiles ?? []);
      const resolvedVersion = inference.artifact.slice("node:".length);
      normalizeNpmGlobals(input.service.globals);
      const files = (input.projectFiles ?? []).map((file) => ({
        path: file.path,
        present: file.present,
        ...(file.present ? { sha256: file.sha256 } : {}),
      }));
      return {
        base: "lando" as const,
        normalizedConfig: normalizedService(input.service, resolvedVersion),
        features: [
          { id: NODE_FEATURE_ID, config: { version: resolvedVersion } },
          { id: "lando.app-mount", config: { target: APP_MOUNT_TARGET } },
        ],
        metadata: {
          node: {
            sourcePath: inference.sourcePath,
            normalizedConstraint: inference.normalizedConstraint,
            artifact: inference.artifact,
            files,
          },
        },
      };
    }),
};
