import { AbsolutePath, PortablePath, ProviderId, ServiceName } from "@lando/sdk/schema";
import { defineLegacyServiceType } from "./legacy.ts";
import type { LegacyServiceType } from "./legacy.ts";

import { decodeServicePlan } from "./_schema-helpers.ts";
import { appNameFor, buildLandoEnv } from "./env.ts";

export const SUPPORTED_NODE_VERSIONS = ["lts", "22"] as const;
export type SupportedNodeVersion = (typeof SUPPORTED_NODE_VERSIONS)[number];

const APP_MOUNT_TARGET = PortablePath.make("/app");
const DEFAULT_COMMAND = ["sh", "-c", "tail -f /dev/null"] as const;
const DEFAULT_PORT = "3000:3000";

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

const makeNodeServiceType = (version: SupportedNodeVersion): LegacyServiceType =>
  defineLegacyServiceType({
    id: `node:${version}`,
    toServicePlan: (input) => {
      const {
        name,
        service,
        appRoot,
        provider = ProviderId.make("lando"),
        primary = name === "web",
        metadata,
        host,
      } = input;
      const resolvedVersion = validateVersion(service.type, version);
      const serviceType = `node:${resolvedVersion}`;
      const appName = appNameFor(input);
      const environment = buildLandoEnv({
        serviceName: name,
        serviceType,
        appName,
        appPaths: { appRoot: "/app", projectMount: "/app" },
        host,
        userEnv: service.environment ?? {},
      });
      return decodeServicePlan({
        name: ServiceName.make(name),
        type: serviceType,
        provider,
        primary: service.primary ?? primary,
        artifact: { kind: "ref", ref: service.image ?? serviceType },
        command: service.command ?? [...DEFAULT_COMMAND],
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
        endpoints: (service.ports ?? [DEFAULT_PORT]).map((port) => ({
          port: Number(port.split(":").at(-1)?.split("/")[0] ?? 3000),
          protocol: "http",
          name,
        })),
        routes: [],
        dependsOn: (service.dependsOn ?? []).map((dependency) => ({
          service: ServiceName.make(dependency),
          condition: "started",
        })),
        hostAliases: [],
        metadata,
        extensions: {},
      });
    },
  });

export const nodeLtsServiceType: LegacyServiceType = makeNodeServiceType("lts");
export const node22ServiceType: LegacyServiceType = makeNodeServiceType("22");
