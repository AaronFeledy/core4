import { Effect, Schema } from "effect";

import type { ServiceFeatureContext, ServiceFeatureDefinition, ServiceType } from "@lando/sdk/services";
import { loopbackTcpHealthcheck, serviceFeatureApply } from "./_feature-helpers.ts";

import { addServicePortEndpoints } from "./_port-helpers.ts";
import { applyAuthoredProcessFields } from "./_process-helpers.ts";

const DEFAULT_IMAGE = "memcached:1.6";
const DEFAULT_PORT = 11211;
export const MEMCACHED_FEATURE_ID = "service-lando.memcached";

const applyMemcachedFeature = (ctx: ServiceFeatureContext): void => {
  const service = ctx.normalizedConfig;
  const port = service.port ?? DEFAULT_PORT;

  ctx.setArtifact({ kind: "ref", ref: service.image ?? DEFAULT_IMAGE });
  ctx.setCommand(service.command ?? ["memcached", "-p", String(port)]);
  addServicePortEndpoints(ctx, { port, protocol: "tcp" });
  ctx.setHealthcheck(loopbackTcpHealthcheck(port, 30));

  applyAuthoredProcessFields(ctx, ["entrypoint", "workingDirectory", "user"]);
};

export const memcachedServiceFeature: ServiceFeatureDefinition = {
  id: MEMCACHED_FEATURE_ID,
  schema: Schema.Unknown,
  priority: 600,
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
