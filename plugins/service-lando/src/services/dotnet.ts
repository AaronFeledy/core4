import { Effect, Schema } from "effect";

import { PortablePath } from "@lando/sdk/schema";
import { DotnetServiceConfig } from "@lando/sdk/schema/services/dotnet";
import type { ServiceFeatureContext, ServiceFeatureDefinition, ServiceType } from "@lando/sdk/services";
import { rootIdentity, serviceFeatureApply, serviceFeatureValidateEffective } from "./_feature-helpers.ts";

import {
  type ListenerContract,
  assertListenerConfig,
  applicationAuthority,
  plannedPort,
  servicePortEndpoints,
} from "./_port-helpers.ts";
import { applyAuthoredProcessFields } from "./_process-helpers.ts";

export const DEFAULT_PORT = 5000;
export const DOTNET_LISTENER = {
  port: DEFAULT_PORT,
  daemon: "ASP.NET Core",
  variables: ["ASPNETCORE_HTTP_PORTS"],
} as const satisfies ListenerContract;
export const APP_MOUNT_TARGET = "/app";
const DEFAULT_COMMAND = ["tail", "-f", "/dev/null"] as const;
const VERSIONS = ["8.0", "9.0"] as const;
const ARTIFACTS = {
  "8.0": "mcr.microsoft.com/dotnet/sdk:8.0",
  "9.0": "mcr.microsoft.com/dotnet/sdk:9.0",
} as const;
const NUGET_CACHE = {
  store: "lando-cache-nuget",
  target: PortablePath.make("/root/.nuget/packages"),
  readOnly: false,
  kind: "cache",
  key: "nuget",
} as const;

export const DOTNET_FEATURE_ID = "service-lando.dotnet";

const applyDotnetFeature = (ctx: ServiceFeatureContext): void => {
  const service = ctx.normalizedConfig;

  ctx.setArtifact({ kind: "ref", ref: service.image ?? ARTIFACTS["9.0"] });
  ctx.setCommand(service.command ?? [...DEFAULT_COMMAND]);
  const port = plannedPort(service, DOTNET_LISTENER);
  ctx.addEnv("ASPNETCORE_HTTP_PORTS", String(port));
  ctx.setListenerAuthority(applicationAuthority(DOTNET_LISTENER, port));
  ctx.addStorage({
    store: NUGET_CACHE.store,
    target: NUGET_CACHE.target,
    readOnly: NUGET_CACHE.readOnly,
  });

  applyAuthoredProcessFields(ctx, ["entrypoint", "user"]);
};

export const dotnetServiceFeature: ServiceFeatureDefinition = {
  id: DOTNET_FEATURE_ID,
  schema: Schema.Unknown,
  priority: 600,
  validateEffective: serviceFeatureValidateEffective(DOTNET_FEATURE_ID, (ctx) => {
    assertListenerConfig(ctx.normalizedConfig, DOTNET_LISTENER);
    return { handledServiceFields: [] };
  }),
  declareEndpoints: (ctx) =>
    Effect.sync(() =>
      servicePortEndpoints(ctx, {
        port: plannedPort(ctx.normalizedConfig, DOTNET_LISTENER),
        protocol: "http",
      }),
    ),
  apply: serviceFeatureApply(DOTNET_FEATURE_ID, "dotnet service feature failed to apply", applyDotnetFeature),
};

const makeDotnetServiceType = (id: string, image: string): ServiceType => ({
  id,
  name: "dotnet",
  base: "lando",
  versions: VERSIONS,
  artifacts: ARTIFACTS,
  identity: rootIdentity(),
  schema: DotnetServiceConfig,
  resolve: (input) => {
    return Effect.succeed({
      base: "lando",
      normalizedConfig: {
        ...input.service,
        type: "dotnet",
        image: input.service.image ?? image,
        certs: input.service.certs ?? true,
        storage: [...(input.service.storage ?? []), NUGET_CACHE],
      },
      features: [{ id: DOTNET_FEATURE_ID }, { id: "lando.app-mount", config: { target: APP_MOUNT_TARGET } }],
    });
  },
});

export const dotnet80ServiceType = makeDotnetServiceType("dotnet:8.0", ARTIFACTS["8.0"]);
export const dotnet90ServiceType = makeDotnetServiceType("dotnet:9.0", ARTIFACTS["9.0"]);
export const dotnetServiceType = makeDotnetServiceType("dotnet", ARTIFACTS["9.0"]);
