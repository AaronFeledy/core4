import { Schema } from "effect";

import { PortablePath } from "@lando/sdk/schema";
import type { ServiceFeatureContext, ServiceFeatureDefinition, ServiceType } from "@lando/sdk/services";
import { serviceFeatureApply, serviceTypeResolve } from "./_feature-helpers.ts";

import { publishedEndpointsFromPorts } from "./_port-helpers.ts";
import { applyAuthoredProcessFields } from "./_process-helpers.ts";
import { mountAppRoot } from "./_volume-helpers.ts";

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
  applyAuthoredProcessFields(ctx, ["command", "entrypoint", "user"]);

  if (service.appMount !== false) {
    mountAppRoot(ctx);
  }

  for (const endpoint of publishedEndpointsFromPorts(service.ports ?? [], "tcp")) {
    ctx.addEndpoint(endpoint);
  }
};

export const landoServiceFeature: ServiceFeatureDefinition = {
  id: LANDO_FEATURE_ID,
  priority: LANDO_FEATURE_PRIORITY,
  apply: serviceFeatureApply(LANDO_FEATURE_ID, `${LANDO_FEATURE_ID} failed to apply`, applyLandoFeature),
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
    serviceTypeResolve("lando", "Failed to resolve lando service type", () => ({
      base: "lando" as const,
      normalizedConfig: { ...input.service, type: "lando" },
      features: [
        { id: LANDO_FEATURE_ID },
        {
          id: "lando.env",
          config: { appPaths: { appRoot: "/app", projectMount: "/app" } },
        },
      ],
    })),
};
