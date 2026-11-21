import type { ServiceFeatureContext, ServiceFeatureDefinition, ServiceType } from "@lando/sdk/services";
import { Effect, Schema } from "effect";
import { PORT_EXTRA_ARGS_REMEDIATION, extraArgsCommandOptions } from "./_extra-args.ts";
import { serviceFeatureApply } from "./_feature-helpers.ts";
import { launcherAuthority, primaryPortSelector, servicePortEndpoints } from "./_port-helpers.ts";
import { applyAuthoredProcessFields } from "./_process-helpers.ts";
import { tcpProbe } from "./_tcp-probe.ts";

const DEFAULT_IMAGE = "memcached:1.6";
export const MEMCACHED_LISTENER = {
  port: 11211,
  daemon: "Memcached",
  when: "All Memcached services",
  launcher: { setting: (port: number) => `-p ${port}` },
} as const;
export const DEFAULT_PORT = MEMCACHED_LISTENER.port;
const selectPort = primaryPortSelector(MEMCACHED_LISTENER);
export const MEMCACHED_FEATURE_ID = "service-lando.memcached";

const applyMemcachedFeature = (ctx: ServiceFeatureContext): void => {
  const service = ctx.normalizedConfig;
  const port = selectPort(service);

  ctx.setArtifact({ kind: "ref", ref: service.image ?? DEFAULT_IMAGE });
  if (service.command !== undefined) {
    ctx.setCommand(service.command);
    ctx.setListenerAuthority(launcherAuthority(MEMCACHED_LISTENER, port));
  } else {
    ctx.setCommand(
      ["memcached", "-p", String(port)],
      extraArgsCommandOptions([
        { form: "short", name: "p", remediation: PORT_EXTRA_ARGS_REMEDIATION, takesValue: true },
        { form: "long", name: "port", remediation: PORT_EXTRA_ARGS_REMEDIATION, takesValue: true },
      ]),
    );
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
        port: selectPort(ctx.normalizedConfig),
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
  plannedPort: selectPort,
  identity: { defaultUser: "memcache", homes: { memcache: "/home/memcache", root: "/root" } },
  schema: Schema.Unknown,
  resolve: (input) =>
    Effect.succeed({
      base: "lando",
      normalizedConfig: { ...input.service, type: "memcached" },
      features: [{ id: MEMCACHED_FEATURE_ID }],
    }),
};
