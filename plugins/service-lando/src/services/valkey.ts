import { Effect, Schema } from "effect";

import { PortablePath } from "@lando/sdk/schema";
import type { ServiceFeatureContext, ServiceFeatureDefinition, ServiceType } from "@lando/sdk/services";
import { loopbackTcpHealthcheck, serviceFeatureApply } from "./_feature-helpers.ts";

import { appNameFor } from "../app-name.ts";
import { addServicePortEndpoints } from "./_port-helpers.ts";
import { applyAuthoredProcessFields } from "./_process-helpers.ts";

const DEFAULT_IMAGE = "valkey/valkey:8";
const DEFAULT_PORT = 6379;
const DATA_TARGET = PortablePath.make("/data");
export const VALKEY_FEATURE_ID = "service-lando.valkey";

const applyValkeyFeature = (ctx: ServiceFeatureContext): void => {
  const service = ctx.normalizedConfig;
  const appName = appNameFor(ctx);
  const port = service.port ?? DEFAULT_PORT;

  ctx.setArtifact({ kind: "ref", ref: service.image ?? DEFAULT_IMAGE });
  ctx.setCommand(service.command ?? ["valkey-server", "--appendonly", "yes", "--port", String(port)]);
  ctx.addStorage({
    store: `${appName}-valkey-data`,
    target: DATA_TARGET,
    readOnly: false,
  });
  addServicePortEndpoints(ctx, { port, protocol: "tcp" });
  ctx.setHealthcheck(loopbackTcpHealthcheck(port, 30));

  applyAuthoredProcessFields(ctx, ["entrypoint", "workingDirectory", "user"]);
};

export const valkeyServiceFeature: ServiceFeatureDefinition = {
  id: VALKEY_FEATURE_ID,
  schema: Schema.Unknown,
  priority: 600,
  apply: serviceFeatureApply(VALKEY_FEATURE_ID, "valkey service feature failed to apply", applyValkeyFeature),
};

export const valkeyServiceType: ServiceType = {
  id: "valkey",
  name: "valkey",
  base: "lando",
  identity: { defaultUser: "root", homes: { root: "/root" } },
  schema: Schema.Unknown,
  resolve: (input) =>
    Effect.succeed({
      base: "lando",
      normalizedConfig: { ...input.service, type: "valkey" },
      features: [{ id: VALKEY_FEATURE_ID }],
    }),
};
