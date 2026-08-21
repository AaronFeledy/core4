import { Effect, Schema } from "effect";

import { ServiceFeatureError } from "@lando/sdk/errors";
import {
  AbsolutePath,
  type LogSource,
  LogSourceId,
  PortablePath,
  type ServiceConfig,
  ServiceName,
} from "@lando/sdk/schema";
import type {
  AppFeatureContext,
  AppFeatureDefinition,
  AppFeatureServiceView,
  ServiceFeatureContext,
  ServiceFeatureDefinition,
  ServiceType,
} from "@lando/sdk/services";

import { addServicePortEndpoints } from "./_port-helpers.ts";
import { PHP_FPM_PORT, phpListenPort } from "./php-via.ts";

const DEFAULT_IMAGE = "nginx:1.26-alpine";
const DEFAULT_PORT = 80;
const APP_MOUNT_TARGET = PortablePath.make("/app");

const NGINX_LOG_SOURCES: ReadonlyArray<LogSource> = [
  {
    id: LogSourceId.make("access"),
    label: "nginx access log",
    path: AbsolutePath.make("/var/log/nginx/access.log"),
    stream: "stdout",
    strategy: "redirect",
    required: false,
    timestamps: false,
  },
  {
    id: LogSourceId.make("error"),
    label: "nginx error log",
    path: AbsolutePath.make("/var/log/nginx/error.log"),
    stream: "stderr",
    strategy: "redirect",
    required: false,
    timestamps: false,
  },
];

export const NGINX_FEATURE_ID = "service-lando.nginx" as const;
export const NGINX_FEATURE_PRIORITY = 600;
export const NGINX_PHP_FPM_WIRE_FEATURE_ID = "service-lando.nginx.php-fpm.wire" as const;

const phpFastcgiCommand = (
  backend: string,
  webroot: string,
  ports: { readonly listen: number; readonly fpm: number },
): ReadonlyArray<string> => [
  "sh",
  "-c",
  [
    "set -eu",
    "cat > /etc/nginx/conf.d/default.conf <<'LANDO_NGINX_PHP'",
    "server {",
    `  listen ${String(ports.listen)};`,
    `  root ${webroot};`,
    "  index index.php index.html;",
    "  location / {",
    "    try_files $uri $uri/ /index.php?$query_string;",
    "  }",
    "  location ~ \\.php$ {",
    `    fastcgi_pass ${backend}:${String(ports.fpm)};`,
    "    fastcgi_param SCRIPT_FILENAME $document_root$fastcgi_script_name;",
    "    include fastcgi_params;",
    "    fastcgi_index index.php;",
    "  }",
    "}",
    "LANDO_NGINX_PHP",
    "exec nginx -g 'daemon off;'",
  ].join("\n"),
];

const applyNginxFeature = (ctx: ServiceFeatureContext): void => {
  const service = ctx.normalizedConfig;
  const port = service.port ?? DEFAULT_PORT;
  const webroot = service.webroot ?? APP_MOUNT_TARGET;
  const backend = service.backend?.trim() ?? "";

  ctx.setArtifact({ kind: "ref", ref: service.image ?? DEFAULT_IMAGE });
  ctx.setWorkingDirectory(service.workingDirectory ?? PortablePath.make(webroot));
  if (service.user !== undefined) ctx.setUser(service.user);
  const passthrough = { realization: "passthrough" as const };
  const appMount = {
    source: AbsolutePath.make(ctx.appRoot),
    target: APP_MOUNT_TARGET,
    readOnly: false,
    excludes: [],
    includes: [],
    ...passthrough,
  };
  const bindMount = {
    type: "bind" as const,
    source: ctx.appRoot,
    target: APP_MOUNT_TARGET,
    readOnly: false,
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

  if (backend.length > 0) {
    ctx.addDependency({
      service: ServiceName.make(backend),
      condition: "service_healthy",
      required: true,
    });
    if (service.command === undefined && service.entrypoint === undefined) {
      ctx.setCommand(phpFastcgiCommand(backend, webroot, { listen: port, fpm: PHP_FPM_PORT }));
    }
  }

  if (service.command !== undefined) ctx.setCommand(service.command);
  if (service.entrypoint !== undefined) ctx.setEntrypoint(service.entrypoint);
};

export const nginxServiceFeature: ServiceFeatureDefinition = {
  id: NGINX_FEATURE_ID,
  schema: Schema.Unknown,
  priority: NGINX_FEATURE_PRIORITY,
  apply: (ctx) =>
    Effect.try({
      try: () => applyNginxFeature(ctx),
      catch: (cause) =>
        new ServiceFeatureError({
          message: cause instanceof Error ? cause.message : "service-lando.nginx failed to apply",
          feature: NGINX_FEATURE_ID,
          cause,
        }),
    }),
};

const isPhpFpm = (view: AppFeatureServiceView): boolean =>
  view.serviceType.startsWith("php:") && view.normalizedConfig.via === "fpm";

const applyNginxPhpFpmWire = (ctx: AppFeatureContext): void => {
  const fpmPortByService = new Map<string, number>();
  for (const view of ctx.selected) {
    if (!isPhpFpm(view)) continue;
    fpmPortByService.set(view.serviceName, phpListenPort("fpm", view.normalizedConfig.port));
  }

  ctx.forEachSelected((mutator) => {
    if (mutator.service.serviceType !== "nginx") return;
    const service = mutator.service.normalizedConfig;
    if (service.command !== undefined || service.entrypoint !== undefined) return;
    const backend = service.backend?.trim() ?? "";
    if (backend.length === 0) return;
    const fpm = fpmPortByService.get(backend);
    if (fpm === undefined) return;
    const listen = service.port ?? DEFAULT_PORT;
    const webroot = service.webroot ?? APP_MOUNT_TARGET;
    mutator.setCommand(phpFastcgiCommand(backend, webroot, { listen, fpm }));
  });
};

export const nginxPhpFpmWireFeature: AppFeatureDefinition = {
  id: NGINX_PHP_FPM_WIRE_FEATURE_ID,
  priority: 100,
  activatedBy: { services: { type: "nginx" } },
  apply: (ctx) => Effect.sync(() => applyNginxPhpFpmWire(ctx)),
};

const normalizedService = (service: ServiceConfig): ServiceConfig => ({
  ...service,
  type: "nginx",
});

export const nginxServiceType: ServiceType = {
  id: "nginx",
  name: "nginx",
  base: "lando",
  schema: Schema.Unknown,
  resolve: (input) =>
    Effect.succeed({
      base: "lando" as const,
      normalizedConfig: normalizedService(input.service),
      logSources: NGINX_LOG_SOURCES,
      features: [
        { id: NGINX_FEATURE_ID },
        {
          id: "lando.env",
          config: {
            appPaths: { appRoot: "/app", projectMount: "/app" },
            webroot: input.service.webroot ?? "/app",
          },
        },
      ],
    }),
};
