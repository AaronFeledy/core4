import { Effect, Schema } from "effect";

import type { ServiceConfig } from "@lando/sdk/schema";
import type { ServiceFeatureContext, ServiceFeatureDefinition, ServiceType } from "@lando/sdk/services";
import {
  ServiceConfigIssue,
  rootIdentity,
  serviceFeatureApply,
  serviceFeatureValidateEffective,
  serviceTypeResolve,
} from "./_feature-helpers.ts";
import { tcpProbe } from "./_tcp-probe.ts";

import { servicePortEndpoints } from "./_port-helpers.ts";
import { applyAuthoredProcessFields } from "./_process-helpers.ts";
import { resolveWebroot } from "./_webroot.ts";
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

export const DEFAULT_PORT = 80;
export const APP_MOUNT_TARGET = "/app";

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
  throw new ServiceConfigIssue(
    ["type"],
    `Unsupported static server "${server}".`,
    REMEDIATION_SERVER(server),
  );
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
  applyAuthoredProcessFields(ctx, ["user"]);
  ctx.setHealthcheck(tcpProbe(port, 10));

  applyAuthoredProcessFields(ctx, ["entrypoint"]);

  ctx.addExtension("lando-service-static", {
    server,
    webroot: docRoot,
  });
};

export const staticServiceFeature: ServiceFeatureDefinition = {
  id: STATIC_FEATURE_ID,
  schema: StaticFeatureConfigSchema as Schema.Codec<unknown>,
  priority: STATIC_FEATURE_PRIORITY,
  validateEffective: serviceFeatureValidateEffective(STATIC_FEATURE_ID, (ctx) => {
    const { docRoot } = Schema.decodeUnknownSync(StaticFeatureConfigSchema)(ctx.config);
    return { handledServiceFields: docRoot.length > 0 ? ["webroot"] : [] };
  }),
  declareEndpoints: (ctx) =>
    Effect.sync(() =>
      servicePortEndpoints(ctx, { port: ctx.normalizedConfig.port ?? DEFAULT_PORT, protocol: "http" }),
    ),
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
    // Verified linux/amd64: nginx:1.26-alpine config
    // sha256:42ce3d3585d47518cb0c1ef4bd3d8a65c1edfcbbfd423eda86990a83f378b111 has
    // nginx:x:101:101:nginx:/var/cache/nginx:/sbin/nologin (cache, not a persisted home).
    // caddy:2-alpine config sha256:3067cc4e02c091399edbd5d65f85a3ff4d511574aecadb47f280c3761e68852e
    // has only root. Both server choices therefore declare only the root home.
    identity: rootIdentity(),
    schema: Schema.Unknown,
    resolve: (input) =>
      serviceTypeResolve(id, `Failed to resolve ${id}`, () => {
        const resolvedServer = validateServer(input.service.type, server);
        const serviceType = `static:${resolvedServer}`;
        const docRoot = resolveWebroot("Static", input.service.webroot, input.service.appMount);

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
              config: { webroot: docRoot },
            },
            { id: "lando.app-mount", config: { target: APP_MOUNT_TARGET, readOnly: true } },
          ],
        };
      }),
  };
};

export const staticNginxServiceType: ServiceType = makeStaticServiceType("nginx");
export const staticCaddyServiceType: ServiceType = makeStaticServiceType("caddy");
