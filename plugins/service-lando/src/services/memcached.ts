import { Effect, Schema } from "effect";

import type { ServiceFeatureContext, ServiceFeatureDefinition, ServiceType } from "@lando/sdk/services";
import { serviceFeatureApply } from "./_feature-helpers.ts";
import { tcpProbe } from "./_tcp-probe.ts";

import { launcherAuthority, plannedPort, servicePortEndpoints } from "./_port-helpers.ts";
import { applyAuthoredProcessFields } from "./_process-helpers.ts";

const DEFAULT_IMAGE = "memcached:1.6";
export const MEMCACHED_LISTENER = {
  port: 11211,
  daemon: "Memcached",
  launcher: { setting: (port: number) => `-p ${port}` },
} as const;
export const DEFAULT_PORT = MEMCACHED_LISTENER.port;
export const MEMCACHED_FEATURE_ID = "service-lando.memcached";

const applyMemcachedFeature = (ctx: ServiceFeatureContext): void => {
  const service = ctx.normalizedConfig;
  const port = plannedPort(service, MEMCACHED_LISTENER);

  ctx.setArtifact({ kind: "ref", ref: service.image ?? DEFAULT_IMAGE });
  if (service.command !== undefined) {
    ctx.setCommand(service.command);
    ctx.setListenerAuthority(launcherAuthority(MEMCACHED_LISTENER, port));
  } else {
    ctx.setCommand(["memcached", "-p", String(port)]);
  }
  ctx.setHealthcheck(tcpProbe(port, 30));

  applyAuthoredProcessFields(ctx, ["entrypoint", "workingDirectory", "user"]);
};

export const memcachedServiceFeature: ServiceFeatureDefinition = {
  id: MEMCACHED_FEATURE_ID,
  schema: Schema.Unknown,
  priority: 600,
  declareEndpoints: (ctx) =>
    Effect.sync(() =>
      servicePortEndpoints(ctx, {
        port: plannedPort(ctx.normalizedConfig, MEMCACHED_LISTENER),
        protocol: "tcp",
      }),
    ),
  apply: serviceFeatureApply(
    MEMCACHED_FEATURE_ID,
    "memcached service feature failed to apply",
    applyMemcachedFeature,
  ),
};

export const memcachedServiceType: ServiceType = {
  id: "memcached",
  name: "memcached",
  base: "lando",
  identity: { defaultUser: "memcache", homes: { memcache: "/home/memcache", root: "/root" } },
  schema: Schema.Unknown,
  resolve: (input) =>
    Effect.succeed({
      base: "lando",
      normalizedConfig: { ...input.service, type: "memcached" },
      features: [{ id: MEMCACHED_FEATURE_ID }],
    }),
};
