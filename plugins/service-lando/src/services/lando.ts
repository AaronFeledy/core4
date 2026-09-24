import { Effect, Schema } from "effect";

import { ServiceFeatureError, ServiceTypeError } from "@lando/sdk/errors";
import { AbsolutePath, PortablePath } from "@lando/sdk/schema";
import type { ServiceFeatureContext, ServiceFeatureDefinition, ServiceType } from "@lando/sdk/services";

import { publishedEndpointsFromPorts } from "./_port-helpers.ts";

export const LANDO_FEATURE_ID = "service-lando.lando" as const;
export const LANDO_FEATURE_PRIORITY = 600;

const APP_MOUNT_TARGET = PortablePath.make("/app");

const applyLandoFeature = (ctx: ServiceFeatureContext): void => {
  const service = ctx.normalizedConfig;
  const hasImage = service.image !== undefined && service.image.length > 0;
  const hasComposeBuild = service.build !== undefined && "context" in service.build;
  if (!hasImage && !hasComposeBuild) {
    throw new Error(
      `lando service "${ctx.serviceName}" requires "image:" or "build:" (Compose build block) — the raw \`type: lando\` base has no default artifact.`,
    );
  }

  if (hasImage) ctx.setArtifact({ kind: "ref", ref: service.image });
  ctx.setWorkingDirectory(service.workingDirectory ?? APP_MOUNT_TARGET);
  if (service.command !== undefined) ctx.setCommand(service.command);
  if (service.entrypoint !== undefined) ctx.setEntrypoint(service.entrypoint);
  if (service.user !== undefined) ctx.setUser(service.user);

  if (service.appMount !== false) {
    ctx.setAppMount({
      source: AbsolutePath.make(ctx.appRoot),
      target: APP_MOUNT_TARGET,
      readOnly: false,
      excludes: [],
      includes: [],
    });
    ctx.addMount({
      type: "bind",
      source: ctx.appRoot,
      target: APP_MOUNT_TARGET,
      readOnly: false,
    });
  }

  for (const endpoint of publishedEndpointsFromPorts(service.ports ?? [], "tcp")) {
    ctx.addEndpoint(endpoint);
  }
};

export const landoServiceFeature: ServiceFeatureDefinition = {
  id: LANDO_FEATURE_ID,
  priority: LANDO_FEATURE_PRIORITY,
  apply: (ctx) =>
    Effect.try({
      try: () => applyLandoFeature(ctx),
      catch: (cause) =>
        new ServiceFeatureError({
          message: cause instanceof Error ? cause.message : `${LANDO_FEATURE_ID} failed to apply`,
          feature: LANDO_FEATURE_ID,
          cause,
        }),
    }),
};

/**
 * The raw `type: lando` base service: a user-supplied image or Compose build on the full
 * lando feature stack (identity env, app mount, storage, healthcheck).
 * No framework opinion, no default command — the artifact's own entrypoint
 * runs unless the Landofile overrides it.
 */
export const landoServiceType: ServiceType = {
  id: "lando",
  name: "lando",
  base: "lando",
  schema: Schema.Unknown,
  resolve: (input) =>
    Effect.try({
      try: () => ({
        base: "lando" as const,
        normalizedConfig: { ...input.service, type: "lando" },
        features: [
          { id: LANDO_FEATURE_ID },
          {
            id: "lando.env",
            config: { appPaths: { appRoot: "/app", projectMount: "/app" } },
          },
        ],
      }),
      catch: (cause) =>
        new ServiceTypeError({
          message: cause instanceof Error ? cause.message : "Failed to resolve lando service type",
          serviceType: "lando",
          cause,
        }),
    }),
};
