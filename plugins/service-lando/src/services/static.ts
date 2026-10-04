import { Schema } from "effect";

import { AbsolutePath, PortablePath, type ServiceConfig } from "@lando/sdk/schema";
import type { ServiceFeatureContext, ServiceFeatureDefinition, ServiceType } from "@lando/sdk/services";
import { serviceFeatureApply, serviceTypeResolve } from "./_feature-helpers.ts";

import { addServicePortEndpoints } from "./_port-helpers.ts";
import { applyAuthoredProcessFields } from "./_process-helpers.ts";
import { landoErrorPagesBuildStep, nginxErrorPageConfigLines } from "./http-errors.ts";
import { nginxDefaultSiteRemovalBuildStep, nginxLauncherCommand } from "./nginx-config.ts";

export const SUPPORTED_STATIC_SERVERS = ["nginx", "caddy"] as const;
export type SupportedStaticServer = (typeof SUPPORTED_STATIC_SERVERS)[number];

export const STATIC_SERVER_IMAGES: Record<SupportedStaticServer, string> = {
  nginx: "nginx:1.26-alpine",
  caddy: "caddy:2-alpine",
};

export const STATIC_FEATURE_ID = "service-lando.static" as const;
export const STATIC_FEATURE_PRIORITY = 600;

const DEFAULT_PORT = 80;
const APP_MOUNT_TARGET = PortablePath.make("/app");
const StaticWebroot = Schema.String.pipe(
  Schema.check(
    Schema.isPattern(/^\/[A-Za-z0-9._/-]*$/u, {
      message:
        "Static webroot must be an absolute container path using only letters, digits, '.', '_', '-', and '/'.",
    }),
  ),
  Schema.brand("StaticWebroot"),
);

export const nginxRootLiteral = (path: string): string => JSON.stringify(path);

export const defaultStaticCommand = (
  server: SupportedStaticServer,
  docRoot: string,
  port: number,
  user: string | undefined,
): ReadonlyArray<string> => {
  if (server === "caddy") {
    return ["caddy", "file-server", "--listen", `:${port}`, "--root", docRoot];
  }

  return nginxLauncherCommand({
    user,
    serverBlock: [
      "server {",
      `  listen ${port};`,
      "  server_name _;",
      `  root ${nginxRootLiteral(docRoot)};`,
      "  index index.html index.htm;",
      ...nginxErrorPageConfigLines(),
      "  location / { try_files $uri $uri/ =404; }",
      "}",
    ],
  });
};

const StaticFeatureConfigSchema = Schema.Struct({
  server: Schema.Literals([...SUPPORTED_STATIC_SERVERS]),
  docRoot: Schema.String,
});
type StaticFeatureConfig = typeof StaticFeatureConfigSchema.Type;

const REMEDIATION_SERVER = (requested: string): string =>
  `Set type to one of: ${SUPPORTED_STATIC_SERVERS.map((s) => `static:${s}`).join(", ")} (got static:${requested}).`;

export const validateServer = (
  declaredType: string | undefined,
  fallback: SupportedStaticServer,
): SupportedStaticServer => {
  if (declaredType === undefined) return fallback;
  if (!declaredType.startsWith("static")) return fallback;
  if (declaredType === "static") return fallback;
  const server = declaredType.slice("static:".length);
  if ((SUPPORTED_STATIC_SERVERS as ReadonlyArray<string>).includes(server)) {
    return server as SupportedStaticServer;
  }
  throw new Error(`Unsupported static server "${server}". ${REMEDIATION_SERVER(server)}`);
};

const configFor = (ctx: ServiceFeatureContext): StaticFeatureConfig => ctx.config as StaticFeatureConfig;

const applyStaticFeature = (ctx: ServiceFeatureContext): void => {
  const service = ctx.normalizedConfig;
  const { docRoot, server } = configFor(ctx);
  const port = service.port ?? DEFAULT_PORT;

  ctx.setArtifact({ kind: "ref", ref: service.image ?? STATIC_SERVER_IMAGES[server] });
  const ownsCommand = service.command === undefined && service.entrypoint === undefined;
  if (server !== "caddy") {
    ctx.addBuildStep(landoErrorPagesBuildStep());
    // The removal only makes sense while the generated launcher, which declares
    // its own server block, is still the planned command.
    if (ownsCommand) ctx.addBuildStep(nginxDefaultSiteRemovalBuildStep());
  }
  ctx.setCommand(service.command ?? defaultStaticCommand(server, docRoot, port, service.user));
  ctx.setWorkingDirectory(service.workingDirectory ?? APP_MOUNT_TARGET);
  applyAuthoredProcessFields(ctx, ["user"]);
  const passthrough = { realization: "passthrough" as const };
  const appMount = {
    source: AbsolutePath.make(ctx.appRoot),
    target: APP_MOUNT_TARGET,
    readOnly: true,
    excludes: [],
    includes: [],
    ...passthrough,
  };
  const bindMount = {
    type: "bind" as const,
    source: ctx.appRoot,
    target: APP_MOUNT_TARGET,
    readOnly: true,
    ...passthrough,
  };
  ctx.setAppMount(appMount);
  ctx.addMount(bindMount);
  addServicePortEndpoints(ctx, { port, protocol: "http" });
  ctx.setHealthcheck({
    kind: "command",
    command: ["sh", "-c", `nc -z 127.0.0.1 ${port}`],
    intervalSeconds: 10,
    timeoutSeconds: 5,
    retries: 5,
    startPeriodSeconds: 10,
  });

  applyAuthoredProcessFields(ctx, ["entrypoint"]);

  ctx.addExtension("lando-service-static", {
    server,
    ...(service.webroot != null ? { webroot: service.webroot } : {}),
  });
};

export const staticServiceFeature: ServiceFeatureDefinition = {
  id: STATIC_FEATURE_ID,
  schema: StaticFeatureConfigSchema as Schema.Codec<unknown>,
  priority: STATIC_FEATURE_PRIORITY,
  apply: serviceFeatureApply(STATIC_FEATURE_ID, "service-lando.static failed to apply", applyStaticFeature),
};

const normalizedService = (service: ServiceConfig, serviceType: string): ServiceConfig => ({
  ...service,
  type: serviceType,
});

export const makeStaticServiceType = (server: SupportedStaticServer): ServiceType => {
  const id = server === "nginx" ? "static" : `static:${server}`;

  return {
    id,
    name: id,
    base: "lando",
    identity: { defaultUser: "root", homes: { root: "/root" } },
    schema: Schema.Unknown,
    resolve: (input) =>
      serviceTypeResolve(id, `Failed to resolve ${id}`, () => {
        const resolvedServer = validateServer(input.service.type, server);
        const serviceType = `static:${resolvedServer}`;
        const docRoot = Schema.decodeUnknownSync(StaticWebroot)(input.service.webroot ?? APP_MOUNT_TARGET);

        return {
          base: "lando" as const,
          normalizedConfig: normalizedService(input.service, serviceType),
          features: [
            {
              id: STATIC_FEATURE_ID,
              config: { server: resolvedServer, docRoot },
            },
            {
              id: "lando.env",
              config: { appPaths: { appRoot: "/app", projectMount: "/app" }, webroot: docRoot },
            },
          ],
        };
      }),
  };
};

export const staticNginxServiceType: ServiceType = makeStaticServiceType("nginx");
export const staticCaddyServiceType: ServiceType = makeStaticServiceType("caddy");
