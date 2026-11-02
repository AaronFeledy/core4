import { Effect, Schema } from "effect";

import { PortablePath } from "@lando/sdk/schema";
import type { ServiceFeatureContext, ServiceFeatureDefinition, ServiceType } from "@lando/sdk/services";
import { rootIdentity, serviceFeatureApply } from "./_feature-helpers.ts";
import { tcpProbe } from "./_tcp-probe.ts";

import { appNameFor } from "../app-name.ts";
import { launcherAuthority, plannedPort, servicePortEndpoints } from "./_port-helpers.ts";
import { applyAuthoredProcessFields } from "./_process-helpers.ts";

const DEFAULT_IMAGE = "valkey/valkey:8";
export const VALKEY_LISTENER = {
  port: 6379,
  daemon: "Valkey",
  when: "All Valkey services",
  launcher: { setting: (port: number) => `--port ${port}` },
} as const;
export const DEFAULT_PORT = VALKEY_LISTENER.port;
const DATA_TARGET = PortablePath.make("/data");
export const VALKEY_FEATURE_ID = "service-lando.valkey";

const applyValkeyFeature = (ctx: ServiceFeatureContext): void => {
  const service = ctx.normalizedConfig;
  const appName = appNameFor(ctx);
  const port = plannedPort(service, VALKEY_LISTENER);

  ctx.setArtifact({ kind: "ref", ref: service.image ?? DEFAULT_IMAGE });
  if (service.command !== undefined) {
    ctx.setCommand(service.command);
    ctx.setListenerAuthority(launcherAuthority(VALKEY_LISTENER, port));
  } else {
    ctx.setCommand(["valkey-server", "--appendonly", "yes", "--port", String(port)]);
  }
  ctx.addStorage({
    store: `${appName}-valkey-data`,
    target: DATA_TARGET,
    readOnly: false,
  });
  ctx.setHealthcheck(tcpProbe(port, 30));

  applyAuthoredProcessFields(ctx, ["entrypoint", "workingDirectory", "user"]);
};

export const valkeyServiceFeature: ServiceFeatureDefinition = {
  id: VALKEY_FEATURE_ID,
  schema: Schema.Unknown,
  priority: 600,
  declareEndpoints: (ctx) =>
    Effect.sync(() =>
      servicePortEndpoints(ctx, {
        port: plannedPort(ctx.normalizedConfig, VALKEY_LISTENER),
        protocol: "tcp",
      }),
    ),
  apply: serviceFeatureApply(VALKEY_FEATURE_ID, "valkey service feature failed to apply", applyValkeyFeature),
};

export const valkeyServiceType: ServiceType = {
  id: "valkey",
  name: "valkey",
  base: "lando",
  identity: rootIdentity(),
  schema: Schema.Unknown,
  resolve: (input) =>
    Effect.succeed({
      base: "lando",
      normalizedConfig: { ...input.service, type: "valkey" },
      features: [{ id: VALKEY_FEATURE_ID }],
    }),
};
