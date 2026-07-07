import { Effect, Schema } from "effect";

import { ServiceFeatureError, ServiceTypeError } from "@lando/sdk/errors";
import { AbsolutePath, PortablePath, ServiceName } from "@lando/sdk/schema";
import type { ServiceFeatureContext, ServiceFeatureDefinition, ServiceType } from "@lando/sdk/services";

export const LANDO_FEATURE_ID = "service-lando.lando" as const;
export const LANDO_FEATURE_PRIORITY = 600;

const APP_MOUNT_TARGET = PortablePath.make("/app");

const parsePortShortForm = (entry: string): { port: number; protocol: "tcp" | "udp" } => {
  const parts = entry.split(":");
  const last = parts[parts.length - 1];
  if (last === undefined) {
    throw new Error(`Invalid port entry "${entry}".`);
  }
  const [portPart, protoPart] = last.split("/");
  const port = Number(portPart);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`Invalid port "${entry}". Expected positive integer port.`);
  }
  const protocol = protoPart === "udp" ? "udp" : "tcp";
  return { port, protocol };
};

const applyLandoFeature = (ctx: ServiceFeatureContext): void => {
  const service = ctx.normalizedConfig;
  if (service.image === undefined || service.image.length === 0) {
    throw new Error(
      `lando service "${ctx.serviceName}" requires "image:" — the raw \`type: lando\` base has no default image. Pin a version-tagged image (e.g. "debian:12.11-slim").`,
    );
  }

  ctx.setArtifact({ kind: "ref", ref: service.image });
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

  for (const portEntry of service.ports ?? []) {
    const parsed = parsePortShortForm(portEntry);
    ctx.addEndpoint({ port: parsed.port, protocol: parsed.protocol, name: ctx.serviceName });
  }

  for (const dependency of service.dependsOn ?? []) {
    ctx.addDependency({ service: ServiceName.make(dependency), condition: "started" });
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
 * The raw `type: lando` base service: a user-supplied image on the full
 * lando feature stack (identity env, app mount, storage, healthcheck).
 * No framework opinion, no default command — the image's own entrypoint
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
