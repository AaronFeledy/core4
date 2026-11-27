import { type ServiceConfig, sameImageReference } from "@lando/sdk/schema";
import type { ServiceFeatureContext, ServiceFeatureDefinition, ServiceType } from "@lando/sdk/services";
import { Effect, Schema } from "effect";
import { UNSUPPORTED_LAUNCHER_EXTRA_ARGS_REMEDIATION } from "./_extra-args.ts";
import {
  ServiceConfigIssue,
  rootIdentity,
  serviceFeatureApply,
  serviceFeatureValidateEffective,
  serviceTypeResolve,
} from "./_feature-helpers.ts";
import {
  type ListenerContract,
  imageAuthority,
  launcherAuthority,
  plannedPort,
  servicePortEndpoints,
} from "./_port-helpers.ts";
import { applyAuthoredProcessFields } from "./_process-helpers.ts";
import { tcpProbe } from "./_tcp-probe.ts";
import { resolveWebroot } from "./_webroot.ts";
import { CADDY_CONFIG_PATH, caddyLauncherCommand, renderCaddyfile } from "./caddy-config.ts";
import { NGINX_DEFAULT_IMAGE } from "./default-images.ts";
import { landoErrorPagesBuildStep, nginxErrorPageConfigLines } from "./http-errors.ts";
import { nginxHiddenPathConfigLines } from "./http-hidden-paths.ts";
import { nginxDefaultSiteRemovalBuildStep, nginxLauncherCommand } from "./nginx-config.ts";

export const SUPPORTED_STATIC_SERVERS = ["nginx", "caddy"] as const;
export type SupportedStaticServer = (typeof SUPPORTED_STATIC_SERVERS)[number];

export const STATIC_SERVER_IMAGES: Record<SupportedStaticServer, string> = {
  nginx: NGINX_DEFAULT_IMAGE,
  caddy: "caddy:2-alpine",
};

export const STATIC_FEATURE_ID = "service-lando.static" as const;
export const STATIC_FEATURE_PRIORITY = 600;

export const STATIC_LISTENERS = {
  nginx: {
    port: 80,
    daemon: "nginx",
    when: "type: static or static:nginx",
    launcher: { setting: (port: number) => `listen ${port};` },
  },
  caddy: {
    port: 80,
    daemon: "caddy",
    when: "type: static:caddy",
    launcher: {
      setting: () => `--config ${CADDY_CONFIG_PATH} --adapter caddyfile`,
    },
    image: {
      setting: (port: number) => `Caddyfile site address http://:${port}`,
      file: "/etc/caddy/Caddyfile",
    },
  },
} as const satisfies Readonly<Record<SupportedStaticServer, ListenerContract>>;
export const STATIC_LISTENER = STATIC_LISTENERS.nginx;
export const DEFAULT_PORT = STATIC_LISTENER.port;
export const APP_MOUNT_TARGET = "/app";

export const nginxRootLiteral = (path: string): string => JSON.stringify(path);

export const defaultNginxStaticCommand = (
  docRoot: string,
  port: number,
  user: string | undefined,
): ReadonlyArray<string> =>
  nginxLauncherCommand({
    user,
    httpBlock: [
      "server {",
      `  listen ${port};`,
      "  server_name _;",
      `  root ${nginxRootLiteral(docRoot)};`,
      "  index index.html index.htm;",
      ...nginxErrorPageConfigLines(),
      ...nginxHiddenPathConfigLines(),
      "  location / { try_files $uri $uri/ =404; }",
      "}",
    ],
  });

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

const configFor = (ctx: Pick<ServiceFeatureContext, "config">): StaticFeatureConfig =>
  ctx.config as StaticFeatureConfig;

const applyStaticFeature = (ctx: ServiceFeatureContext): void => {
  const service = ctx.normalizedConfig;
  const { docRoot, server } = configFor(ctx);
  const port = selectPort(service, server);

  ctx.setArtifact({ kind: "ref", ref: service.image ?? STATIC_SERVER_IMAGES[server] });
  if (server === "caddy") {
    // The generated Caddyfile needs the bundled Caddy image and the generated
    // launcher. An authored image, replacement `build.context`, command, or
    // entrypoint owns its own server configuration and keeps it; additive build
    // steps do not.
    const ownsImage =
      service.image === undefined || sameImageReference(service.image, STATIC_SERVER_IMAGES.caddy);
    const ownsServerConfig =
      service.command === undefined &&
      service.entrypoint === undefined &&
      !(service.build !== undefined && "context" in service.build) &&
      ownsImage;
    if (ownsServerConfig) {
      ctx.addBuildStep(
        landoErrorPagesBuildStep({
          files: [{ path: CADDY_CONFIG_PATH, content: renderCaddyfile({ port, docRoot }) }],
        }),
      );
      ctx.setCommand(caddyLauncherCommand());
    } else if (service.command !== undefined) {
      ctx.setCommand(service.command);
      ctx.setListenerAuthority(launcherAuthority(STATIC_LISTENERS.caddy, port));
    } else {
      ctx.setListenerAuthority(imageAuthority(STATIC_LISTENERS.caddy, port));
    }
  } else {
    ctx.addBuildStep(landoErrorPagesBuildStep());
    // The removal only makes sense while the generated launcher, which declares
    // its own server block, is still the planned command.
    if (service.command === undefined && service.entrypoint === undefined) {
      ctx.addBuildStep(nginxDefaultSiteRemovalBuildStep());
    }
    // Only an authored command replaces the generated launcher; entrypoint still
    // receives Lando's listen-port argv.
    if (service.command !== undefined) {
      ctx.setCommand(service.command);
      ctx.setListenerAuthority(launcherAuthority(STATIC_LISTENERS.nginx, port));
    } else {
      ctx.setCommand(defaultNginxStaticCommand(docRoot, port, service.user));
    }
  }
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
      servicePortEndpoints(ctx, {
        port: selectPort(ctx.normalizedConfig, configFor(ctx).server),
        protocol: "http",
      }),
    ),
  apply: serviceFeatureApply(STATIC_FEATURE_ID, "service-lando.static failed to apply", applyStaticFeature),
};

const normalizedService = (service: ServiceConfig, serviceType: string): ServiceConfig => ({
  ...service,
  type: serviceType,
});

const selectPort = (service: Pick<ServiceConfig, "port">, server: SupportedStaticServer) =>
  plannedPort(service, STATIC_LISTENERS[server]);

export const makeStaticServiceType = (server: SupportedStaticServer): ServiceType => {
  const id = server === "nginx" ? "static" : `static:${server}`;

  return {
    id,
    name: id,
    base: "lando",
    plannedPort: (service) => selectPort(service, server),
    extraArgsRemediation: UNSUPPORTED_LAUNCHER_EXTRA_ARGS_REMEDIATION(
      server === "caddy" ? "static:caddy" : "static",
      "Put flags in command: or configure the generated server through type settings.",
    ),
    // Verified linux/amd64: nginx:1.30-alpine config
    // sha256:d5f49e5ab196322ceaca86fd802279f6ace122b19c43fa67d80b029f23936f53 has
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
