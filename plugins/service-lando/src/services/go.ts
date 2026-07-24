import { Effect, Schema } from "effect";

import { ServiceFeatureError, ServiceTypeError } from "@lando/sdk/errors";
import { AbsolutePath, PortablePath, type ServiceConfig, ServiceName } from "@lando/sdk/schema";
import type {
  ServiceAppMountIntent,
  ServiceFeatureContext,
  ServiceFeatureDefinition,
  ServiceMountIntent,
  ServiceType,
} from "@lando/sdk/services";

import { addServicePortEndpoints } from "./_port-helpers.ts";

export const SUPPORTED_GO_VERSIONS = ["1.22", "1.23"] as const;
export type SupportedGoVersion = (typeof SUPPORTED_GO_VERSIONS)[number];

export const SUPPORTED_GO_FRAMEWORKS = ["none"] as const;
export type SupportedGoFramework = (typeof SUPPORTED_GO_FRAMEWORKS)[number];

export const GO_FEATURE_ID = "service-lando.go" as const;
export const GO_FEATURE_PRIORITY = 600;

const APP_MOUNT_TARGET = PortablePath.make("/app");
const DEFAULT_PORT = 8080;
const DEFAULT_KEEP_ALIVE: ReadonlyArray<string> = ["sh", "-c", "tail -f /dev/null"];

interface FrameworkPreset {
  readonly port: number;
  readonly defaultCommand: ReadonlyArray<string> | null;
}

type PassthroughAppMount = ServiceAppMountIntent & { readonly realization: "passthrough" };
type PassthroughMount = ServiceMountIntent & { readonly realization: "passthrough" };

const FRAMEWORK_PRESETS: Record<SupportedGoFramework, FrameworkPreset> = {
  none: {
    port: DEFAULT_PORT,
    defaultCommand: null,
  },
};

const GoFeatureConfigSchema = Schema.Struct({
  framework: Schema.Literal(...SUPPORTED_GO_FRAMEWORKS),
  version: Schema.Literal(...SUPPORTED_GO_VERSIONS),
  port: Schema.Number,
  defaultCommand: Schema.optional(Schema.Union(Schema.Null, Schema.Array(Schema.String))),
});
type GoFeatureConfig = typeof GoFeatureConfigSchema.Type;

const REMEDIATION_VERSION = (requested: string): string =>
  `Set type to one of: ${SUPPORTED_GO_VERSIONS.map((v) => `go:${v}`).join(", ")} (got go:${requested}).`;

const REMEDIATION_FRAMEWORK = (requested: string): string =>
  `Set framework to one of: ${SUPPORTED_GO_FRAMEWORKS.join(", ")} (got ${requested}).`;

const frameworkDefaults = (): Record<string, string> => ({
  GOPATH: "/go",
  GOCACHE: "/root/.cache/go-build",
  CGO_ENABLED: "0",
});

const validateFramework = (raw: string | undefined): SupportedGoFramework => {
  if (raw === undefined) return "none";
  if ((SUPPORTED_GO_FRAMEWORKS as ReadonlyArray<string>).includes(raw)) {
    return raw as SupportedGoFramework;
  }
  throw new Error(`Unsupported Go framework "${raw}". ${REMEDIATION_FRAMEWORK(raw)}`);
};

const validateVersion = (
  declaredType: string | undefined,
  fallback: SupportedGoVersion,
): SupportedGoVersion => {
  if (declaredType === undefined) return fallback;
  if (!declaredType.startsWith("go:")) return fallback;
  const version = declaredType.slice("go:".length);
  if ((SUPPORTED_GO_VERSIONS as ReadonlyArray<string>).includes(version)) {
    return version as SupportedGoVersion;
  }
  throw new Error(`Unsupported Go version "${version}". ${REMEDIATION_VERSION(version)}`);
};

const configFor = (ctx: ServiceFeatureContext): GoFeatureConfig => ctx.config as GoFeatureConfig;

const applyGoFeature = (ctx: ServiceFeatureContext): void => {
  const service = ctx.normalizedConfig;
  const { framework, version, port, defaultCommand } = configFor(ctx);

  ctx.setArtifact({ kind: "ref", ref: service.image ?? `golang:${version}` });
  for (const [key, value] of Object.entries(frameworkDefaults())) {
    ctx.addEnv(key, value);
  }
  const appMount: PassthroughAppMount = {
    source: AbsolutePath.make(ctx.appRoot),
    target: APP_MOUNT_TARGET,
    readOnly: false,
    excludes: [],
    includes: [],
    realization: "passthrough" as const,
  };
  const bindMount: PassthroughMount = {
    type: "bind" as const,
    source: ctx.appRoot,
    target: APP_MOUNT_TARGET,
    readOnly: false,
    realization: "passthrough" as const,
  };

  ctx.setCommand(service.command ?? [...DEFAULT_KEEP_ALIVE]);
  ctx.setWorkingDirectory(service.workingDirectory ?? APP_MOUNT_TARGET);
  if (service.user !== undefined) ctx.setUser(service.user);
  ctx.setAppMount(appMount);
  ctx.addMount(bindMount);
  addServicePortEndpoints(ctx, { port, protocol: "http" });
  ctx.setHealthcheck({
    kind: "command",
    command: ["bash", "-c", `exec 3<>/dev/tcp/127.0.0.1/${port}`],
    intervalSeconds: 10,
    timeoutSeconds: 5,
    retries: 5,
    startPeriodSeconds: 10,
  });

  if (service.entrypoint !== undefined) ctx.setEntrypoint(service.entrypoint);
  for (const dependency of service.dependsOn ?? []) {
    ctx.addDependency({ service: ServiceName.make(dependency), condition: "started" });
  }

  ctx.addExtension("lando-service-go", {
    framework,
    version,
    defaultCommand: defaultCommand ?? null,
    port,
  });
};

export const goServiceFeature: ServiceFeatureDefinition = {
  id: GO_FEATURE_ID,
  schema: GoFeatureConfigSchema as Schema.Schema<unknown>,
  priority: GO_FEATURE_PRIORITY,
  apply: (ctx) =>
    Effect.try({
      try: () => applyGoFeature(ctx),
      catch: (cause) =>
        new ServiceFeatureError({
          message: cause instanceof Error ? cause.message : "service-lando.go failed to apply",
          feature: GO_FEATURE_ID,
          cause,
        }),
    }),
};

const normalizedService = (service: ServiceConfig, resolvedVersion: SupportedGoVersion): ServiceConfig => ({
  ...service,
  type: `go:${resolvedVersion}`,
});

const makeGoServiceType = (version: SupportedGoVersion): ServiceType => ({
  id: `go:${version}`,
  name: `go:${version}`,
  base: "lando",
  schema: Schema.Unknown,
  resolve: (input) =>
    Effect.try({
      try: () => {
        const resolvedVersion = validateVersion(input.service.type, version);
        const framework = validateFramework(input.service.framework);
        const preset = FRAMEWORK_PRESETS[framework];
        const endpointPort = input.service.port ?? preset.port;

        return {
          base: "lando" as const,
          normalizedConfig: normalizedService(input.service, resolvedVersion),
          features: [
            {
              id: GO_FEATURE_ID,
              config: {
                framework,
                version: resolvedVersion,
                port: endpointPort,
                defaultCommand: preset.defaultCommand,
              },
            },
            {
              id: "lando.env",
              config: { appPaths: { appRoot: "/app", projectMount: "/app" } },
            },
          ],
        };
      },
      catch: (cause) =>
        new ServiceTypeError({
          message: cause instanceof Error ? cause.message : `Failed to resolve go:${version}`,
          serviceType: `go:${version}`,
          cause,
        }),
    }),
});

export const go122ServiceType: ServiceType = makeGoServiceType("1.22");
export const go123ServiceType: ServiceType = makeGoServiceType("1.23");
