import { AbsolutePath, PortablePath, ProviderId, ServiceName } from "@lando/sdk/schema";
import { defineLegacyServiceType } from "./legacy.ts";
import type { LegacyServiceType } from "./legacy.ts";

import { decodeServicePlan } from "./_schema-helpers.ts";
import { appNameFor, buildLandoEnv } from "./env.ts";

export const SUPPORTED_GO_VERSIONS = ["1.22", "1.23"] as const;
export type SupportedGoVersion = (typeof SUPPORTED_GO_VERSIONS)[number];

export const SUPPORTED_GO_FRAMEWORKS = ["none"] as const;
export type SupportedGoFramework = (typeof SUPPORTED_GO_FRAMEWORKS)[number];

const APP_MOUNT_TARGET = PortablePath.make("/app");
const DEFAULT_PORT = 8080;
const DEFAULT_KEEP_ALIVE: ReadonlyArray<string> = ["sh", "-c", "tail -f /dev/null"];

interface FrameworkPreset {
  readonly port: number;
  readonly defaultCommand: ReadonlyArray<string> | null;
}

const FRAMEWORK_PRESETS: Record<SupportedGoFramework, FrameworkPreset> = {
  none: {
    port: DEFAULT_PORT,
    defaultCommand: null,
  },
};

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

const makeGoServiceType = (version: SupportedGoVersion): LegacyServiceType =>
  defineLegacyServiceType({
    id: `go:${version}`,
    toServicePlan: (input) => {
      const { name, service, appRoot, provider = ProviderId.make("lando"), primary, metadata, host } = input;
      const resolvedVersion = validateVersion(service.type, version);
      const framework = validateFramework(service.framework);
      const preset = FRAMEWORK_PRESETS[framework];
      const appName = appNameFor(input);
      const serviceType = `go:${resolvedVersion}`;
      const environment = buildLandoEnv({
        serviceName: name,
        serviceType,
        appName,
        appPaths: { appRoot: "/app", projectMount: "/app" },
        host,
        extraDefaults: frameworkDefaults(),
        userEnv: service.environment ?? {},
      });
      const endpointPort = service.port ?? preset.port;

      return decodeServicePlan({
        name: ServiceName.make(name),
        type: serviceType,
        provider,
        primary: service.primary ?? primary ?? name === "web",
        artifact: { kind: "ref", ref: service.image ?? `golang:${resolvedVersion}` },
        command: service.command ?? [...DEFAULT_KEEP_ALIVE],
        entrypoint: service.entrypoint,
        environment,
        user: service.user,
        workingDirectory: service.workingDirectory ?? APP_MOUNT_TARGET,
        appMount: {
          source: AbsolutePath.make(appRoot),
          target: APP_MOUNT_TARGET,
          readOnly: false,
          excludes: [],
          includes: [],
          realization: "passthrough",
        },
        mounts: [
          {
            type: "bind",
            source: appRoot,
            target: APP_MOUNT_TARGET,
            readOnly: false,
            realization: "passthrough",
          },
        ],
        storage: [],
        endpoints: [{ port: endpointPort, protocol: "http", name }],
        routes: [],
        dependsOn: (service.dependsOn ?? []).map((dependency) => ({
          service: ServiceName.make(dependency),
          condition: "started",
        })),
        healthcheck: {
          kind: "command",
          command: ["bash", "-c", `exec 3<>/dev/tcp/127.0.0.1/${endpointPort}`],
          intervalSeconds: 10,
          timeoutSeconds: 5,
          retries: 5,
          startPeriodSeconds: 10,
        },
        hostAliases: [],
        metadata,
        extensions: {
          "lando-service-go": {
            framework,
            version: resolvedVersion,
            defaultCommand: preset.defaultCommand,
            port: endpointPort,
          },
        },
      });
    },
  });

export const go122ServiceType: LegacyServiceType = makeGoServiceType("1.22");
export const go123ServiceType: LegacyServiceType = makeGoServiceType("1.23");
