import { basename } from "node:path";

import { Effect, Schema } from "effect";

import { ServiceFeatureError } from "@lando/sdk/errors";
import { AbsolutePath, PortablePath } from "@lando/sdk/schema";
import { DotnetServiceConfig } from "@lando/sdk/schema/services/dotnet";
import type { ServiceFeatureContext, ServiceFeatureDefinition, ServiceType } from "@lando/sdk/services";

import { addServicePortEndpoints } from "./_port-helpers.ts";

const DEFAULT_PORT = 5000;
const APP_MOUNT_TARGET = PortablePath.make("/app");
const DEFAULT_COMMAND = ["sh", "-c", "tail -f /dev/null"] as const;
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

const appNameFor = (input: { readonly appName?: string | undefined; readonly appRoot: string }): string => {
  if (input.appName !== undefined && input.appName.length > 0) return input.appName;
  return basename(input.appRoot) || "app";
};

const applyDotnetFeature = (ctx: ServiceFeatureContext): void => {
  const service = ctx.normalizedConfig;
  const passthrough = { realization: "passthrough" as const };

  ctx.setArtifact({ kind: "ref", ref: service.image ?? ARTIFACTS["9.0"] });
  ctx.setCommand(service.command ?? [...DEFAULT_COMMAND]);
  ctx.setWorkingDirectory(service.workingDirectory ?? APP_MOUNT_TARGET);
  ctx.setAppMount({
    source: AbsolutePath.make(ctx.appRoot),
    target: APP_MOUNT_TARGET,
    readOnly: false,
    excludes: [],
    includes: [],
    ...passthrough,
  });
  ctx.addMount({
    type: "bind",
    source: ctx.appRoot,
    target: APP_MOUNT_TARGET,
    readOnly: false,
    ...passthrough,
  });
  ctx.addStorage({
    store: NUGET_CACHE.store,
    target: NUGET_CACHE.target,
    readOnly: NUGET_CACHE.readOnly,
  });
  addServicePortEndpoints(ctx, { port: service.port ?? DEFAULT_PORT, protocol: "http" });

  if (service.entrypoint !== undefined) ctx.setEntrypoint(service.entrypoint);
  if (service.user !== undefined) ctx.setUser(service.user);
};

export const dotnetServiceFeature: ServiceFeatureDefinition = {
  id: DOTNET_FEATURE_ID,
  schema: Schema.Unknown,
  priority: 600,
  apply: (ctx) =>
    Effect.try({
      try: () => applyDotnetFeature(ctx),
      catch: (cause) =>
        new ServiceFeatureError({
          message: cause instanceof Error ? cause.message : "dotnet service feature failed to apply",
          feature: DOTNET_FEATURE_ID,
          cause,
        }),
    }),
};

const makeDotnetServiceType = (id: string, image: string): ServiceType => ({
  id,
  name: "dotnet",
  base: "lando",
  versions: VERSIONS,
  artifacts: ARTIFACTS,
  schema: DotnetServiceConfig,
  resolve: (input) => {
    const appName = appNameFor(input);
    return Effect.succeed({
      base: "lando",
      normalizedConfig: {
        ...input.service,
        type: "dotnet",
        image: input.service.image ?? image,
        certs: input.service.certs ?? true,
        routes: input.service.routes ?? [
          { hostname: `${input.name}.${appName}.lndo.site`, endpoint: input.service.port ?? DEFAULT_PORT },
        ],
        storage: [...(input.service.storage ?? []), NUGET_CACHE],
      },
      features: [{ id: DOTNET_FEATURE_ID }],
    });
  },
});

export const dotnet80ServiceType = makeDotnetServiceType("dotnet:8.0", ARTIFACTS["8.0"]);
export const dotnet90ServiceType = makeDotnetServiceType("dotnet:9.0", ARTIFACTS["9.0"]);
export const dotnetServiceType = makeDotnetServiceType("dotnet", ARTIFACTS["9.0"]);
