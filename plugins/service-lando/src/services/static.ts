import { Effect, Schema } from "effect";

import { ServiceFeatureError, ServiceTypeError } from "@lando/sdk/errors";
import { AbsolutePath, PortablePath, type ServiceConfig, ServiceName } from "@lando/sdk/schema";
import type { ServiceFeatureContext, ServiceFeatureDefinition, ServiceType } from "@lando/sdk/services";

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

export const nginxRootLiteral = (path: string): string => JSON.stringify(path);

export const defaultStaticCommand = (
  server: SupportedStaticServer,
  docRoot: string,
  port: number,
): ReadonlyArray<string> => {
  if (server === "caddy") {
    return ["caddy", "file-server", "--listen", `:${port}`, "--root", docRoot];
  }

  return [
    "sh",
    "-c",
    [
      "cat > /etc/nginx/conf.d/default.conf <<'LANDO_STATIC_NGINX'",
      "server {",
      `  listen ${port};`,
      "  server_name _;",
      `  root ${nginxRootLiteral(docRoot)};`,
      "  index index.html index.htm;",
      "  location / { try_files $uri $uri/ =404; }",
      "}",
      "LANDO_STATIC_NGINX",
      "exec nginx -g 'daemon off;'",
    ].join("\n"),
  ];
};

const StaticFeatureConfigSchema = Schema.Struct({
  server: Schema.Literal(...SUPPORTED_STATIC_SERVERS),
  docRoot: Schema.String,
  root: Schema.optional(Schema.String),
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
  ctx.setCommand(service.command ?? defaultStaticCommand(server, docRoot, port));
  ctx.setWorkingDirectory(service.workingDirectory ?? APP_MOUNT_TARGET);
  if (service.user !== undefined) ctx.setUser(service.user);
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
  ctx.addEndpoint({ port, protocol: "http", name: ctx.serviceName });
  ctx.setHealthcheck({
    kind: "command",
    command: ["sh", "-c", `nc -z 127.0.0.1 ${port}`],
    intervalSeconds: 10,
    timeoutSeconds: 5,
    retries: 5,
    startPeriodSeconds: 10,
  });

  if (service.entrypoint !== undefined) ctx.setEntrypoint(service.entrypoint);
  for (const dependency of service.dependsOn ?? []) {
    ctx.addDependency({ service: ServiceName.make(dependency), condition: "started" });
  }

  ctx.addExtension("lando-service-static", {
    server,
    ...(service.root != null ? { root: service.root } : {}),
  });
};

export const staticServiceFeature: ServiceFeatureDefinition = {
  id: STATIC_FEATURE_ID,
  schema: StaticFeatureConfigSchema as Schema.Schema<unknown>,
  priority: STATIC_FEATURE_PRIORITY,
  apply: (ctx) =>
    Effect.try({
      try: () => applyStaticFeature(ctx),
      catch: (cause) =>
        new ServiceFeatureError({
          message: cause instanceof Error ? cause.message : "service-lando.static failed to apply",
          feature: STATIC_FEATURE_ID,
          cause,
        }),
    }),
};

const docRootFor = (root: string | undefined): string => {
  const rel = root != null ? root.replace(/^\/+/, "").replace(/\/+$/, "") : "";
  return rel === "" ? "/app" : `/app/${rel}`;
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
    schema: Schema.Unknown,
    resolve: (input) =>
      Effect.try({
        try: () => {
          const resolvedServer = validateServer(input.service.type, server);
          const serviceType = `static:${resolvedServer}`;
          const docRoot = docRootFor(input.service.root);

          return {
            base: "lando" as const,
            normalizedConfig: normalizedService(input.service, serviceType),
            features: [
              {
                id: STATIC_FEATURE_ID,
                config: {
                  server: resolvedServer,
                  docRoot,
                  ...(input.service.root != null ? { root: input.service.root } : {}),
                },
              },
              {
                id: "lando.env",
                config: { appPaths: { appRoot: "/app", projectMount: "/app" }, webroot: docRoot },
              },
            ],
          };
        },
        catch: (cause) =>
          new ServiceTypeError({
            message: cause instanceof Error ? cause.message : `Failed to resolve ${id}`,
            serviceType: id,
            cause,
          }),
      }),
  };
};

export const staticNginxServiceType: ServiceType = makeStaticServiceType("nginx");
export const staticCaddyServiceType: ServiceType = makeStaticServiceType("caddy");
