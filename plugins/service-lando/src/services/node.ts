import { Effect, Schema } from "effect";

import { ServiceFeatureError, ServiceTypeError } from "@lando/sdk/errors";
import { AbsolutePath, PortablePath, type ServiceConfig, ServiceName } from "@lando/sdk/schema";
import type { ServiceFeatureContext, ServiceFeatureDefinition, ServiceType } from "@lando/sdk/services";

import { addServicePortEndpoints } from "./_port-helpers.ts";

export const SUPPORTED_NODE_VERSIONS = ["lts", "22"] as const;
export type SupportedNodeVersion = (typeof SUPPORTED_NODE_VERSIONS)[number];

export const NODE_FEATURE_ID = "service-lando.node" as const;
export const NODE_FEATURE_PRIORITY = 600;

const APP_MOUNT_TARGET = PortablePath.make("/app");
const DEFAULT_COMMAND = ["sh", "-c", "tail -f /dev/null"] as const;
const DEFAULT_PORT = 3000;

const NodeFeatureConfigSchema = Schema.Struct({
  version: Schema.Literal(...SUPPORTED_NODE_VERSIONS),
});
type NodeFeatureConfig = typeof NodeFeatureConfigSchema.Type;

const REMEDIATION_VERSION = (requested: string): string =>
  `Set type to one of: ${SUPPORTED_NODE_VERSIONS.map((v) => `node:${v}`).join(", ")} (got node:${requested}).`;

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
  throw new Error(`Unsupported Node version "${version}". ${REMEDIATION_VERSION(version)}`);
};

const configFor = (ctx: ServiceFeatureContext): NodeFeatureConfig => ctx.config as NodeFeatureConfig;

const applyNodeFeature = (ctx: ServiceFeatureContext): void => {
  const service = ctx.normalizedConfig;
  const { version } = configFor(ctx);
  const serviceType = `node:${version}`;
  const appMount = {
    source: AbsolutePath.make(ctx.appRoot),
    target: APP_MOUNT_TARGET,
    readOnly: false,
    excludes: [],
    includes: [],
    realization: "passthrough" as const,
  };
  const bindMount = {
    type: "bind" as const,
    source: ctx.appRoot,
    target: APP_MOUNT_TARGET,
    readOnly: false,
    realization: "passthrough" as const,
  };

  ctx.setArtifact({ kind: "ref", ref: service.image ?? serviceType });
  ctx.setCommand(service.command ?? [...DEFAULT_COMMAND]);
  ctx.setWorkingDirectory(service.workingDirectory ?? APP_MOUNT_TARGET);
  if (service.user !== undefined) ctx.setUser(service.user);
  ctx.setAppMount(appMount);
  ctx.addMount(bindMount);

  addServicePortEndpoints(ctx, { port: DEFAULT_PORT, protocol: "http" });

  if (service.entrypoint !== undefined) ctx.setEntrypoint(service.entrypoint);
  for (const dependency of service.dependsOn ?? []) {
    ctx.addDependency({ service: ServiceName.make(dependency), condition: "started" });
  }
};

export const nodeServiceFeature: ServiceFeatureDefinition = {
  id: NODE_FEATURE_ID,
  schema: NodeFeatureConfigSchema as Schema.Schema<unknown>,
  priority: NODE_FEATURE_PRIORITY,
  apply: (ctx) =>
    Effect.try({
      try: () => applyNodeFeature(ctx),
      catch: (cause) =>
        new ServiceFeatureError({
          message: cause instanceof Error ? cause.message : "service-lando.node failed to apply",
          feature: NODE_FEATURE_ID,
          cause,
        }),
    }),
};

const normalizedService = (service: ServiceConfig, resolvedVersion: SupportedNodeVersion): ServiceConfig => ({
  ...service,
  type: `node:${resolvedVersion}`,
});

const makeNodeServiceType = (version: SupportedNodeVersion): ServiceType => ({
  id: `node:${version}`,
  name: `node:${version}`,
  base: "lando",
  schema: Schema.Unknown,
  resolve: (input) =>
    Effect.try({
      try: () => {
        const resolvedVersion = validateVersion(input.service.type, version);

        return {
          base: "lando" as const,
          normalizedConfig: normalizedService(input.service, resolvedVersion),
          features: [
            { id: NODE_FEATURE_ID, config: { version: resolvedVersion } },
            {
              id: "lando.env",
              config: { appPaths: { appRoot: "/app", projectMount: "/app" } },
            },
          ],
        };
      },
      catch: (cause) =>
        new ServiceTypeError({
          message: cause instanceof Error ? cause.message : `Failed to resolve node:${version}`,
          serviceType: `node:${version}`,
          cause,
        }),
    }),
});

export const nodeLtsServiceType: ServiceType = makeNodeServiceType("lts");
export const node22ServiceType: ServiceType = makeNodeServiceType("22");
