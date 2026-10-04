import { Effect, Predicate, Schema } from "effect";

import { ServiceFeatureError } from "@lando/sdk/errors";
import { AbsolutePath, PortablePath } from "@lando/sdk/schema";
import type { ServiceFeatureContext, ServiceFeatureDefinition, ServiceType } from "@lando/sdk/services";

import { appNameFor } from "../app-name.ts";
import { internalEndpointsFromExpose, publishedEndpointsFromPorts } from "./_port-helpers.ts";
import { applyAuthoredProcessFields } from "./_process-helpers.ts";
import {
  type ClassifiedComposeVolume,
  classifyComposeVolume,
  occupiedTargets,
  parseServiceMount,
} from "./_volume-helpers.ts";

const APP_MOUNT_TARGET = PortablePath.make("/app");

export const COMPOSE_FEATURE_ID = "service-lando.compose" as const;
export const COMPOSE_FEATURE_PRIORITY = 600;

const applyCompose = (ctx: ServiceFeatureContext): void => {
  const service = ctx.normalizedConfig;
  const hasImage = service.image !== undefined && service.image.length > 0;
  const hasComposeBuild = service.build !== undefined && "context" in service.build;
  if (!hasImage && !hasComposeBuild) {
    throw new Error(
      `compose service "${ctx.serviceName}" requires either "image:" or "build:" (Compose build block).`,
    );
  }

  if (hasImage) {
    ctx.setArtifact({ kind: "ref", ref: service.image as string });
  }

  const appName = appNameFor(ctx);
  const authoredMounts = (service.mounts ?? []).map((entry) => parseServiceMount(entry, ctx.appRoot));
  const optedOutOfAppMount =
    service.appMount === false || authoredMounts.some((mount) => mount.target === APP_MOUNT_TARGET);
  if (!optedOutOfAppMount) {
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

  for (const mount of authoredMounts) {
    ctx.addMount({
      type: mount.type,
      ...(mount.source === undefined ? {} : { source: mount.source }),
      target: PortablePath.make(mount.target),
      readOnly: mount.readOnly,
    });
  }

  const composeVolumes = (service.volumes ?? []).map((entry) =>
    classifyComposeVolume(entry, { appRoot: ctx.appRoot, appName, serviceName: ctx.serviceName }),
  );
  const occupied = occupiedTargets(service, APP_MOUNT_TARGET);
  const tmpfsEntries: Array<Extract<ClassifiedComposeVolume, { readonly _tag: "tmpfs" }>["tmpfs"]> = [];
  for (const volume of composeVolumes.filter((entry) => !occupied.has(entry.target))) {
    switch (volume._tag) {
      case "mount":
        ctx.addMount({
          ...volume.mount,
          target: PortablePath.make(volume.mount.target),
        });
        break;
      case "storage":
        ctx.addStorage({
          ...volume.storage,
          target: PortablePath.make(volume.storage.target),
        });
        break;
      case "tmpfs":
        tmpfsEntries.push(volume.tmpfs);
        break;
      default: {
        const exhaustive: never = volume;
        throw new Error(`Unsupported classified Compose volume: ${exhaustive}`);
      }
    }
  }

  for (const endpoint of publishedEndpointsFromPorts(service.ports ?? [], "tcp")) {
    ctx.addEndpoint(endpoint);
  }
  for (const endpoint of internalEndpointsFromExpose(service.expose ?? [], "tcp")) {
    switch (endpoint.protocol) {
      case "unix":
        ctx.addEndpoint({ ...endpoint, socketPath: PortablePath.make(endpoint.socketPath) });
        break;
      case "http":
      case "https":
      case "tcp":
      case "udp":
        ctx.addEndpoint(endpoint);
        break;
      default:
        endpoint satisfies never;
    }
  }

  applyAuthoredProcessFields(ctx, ["command", "entrypoint", "user", "workingDirectory"]);
  for (const [key, value] of Object.entries(service.providers ?? {})) ctx.addExtension(key, value);
  if (tmpfsEntries.length > 0) {
    const existing = service.providers?.compose;
    ctx.addExtension("compose", {
      ...(Predicate.isObject(existing) ? existing : {}),
      tmpfs: tmpfsEntries,
    });
  }
};

export const composeServiceFeature: ServiceFeatureDefinition = {
  id: COMPOSE_FEATURE_ID,
  priority: COMPOSE_FEATURE_PRIORITY,
  apply: (ctx) =>
    Effect.try({
      try: () => applyCompose(ctx),
      catch: (cause) =>
        new ServiceFeatureError({
          message: cause instanceof Error ? cause.message : `${COMPOSE_FEATURE_ID} failed to apply`,
          feature: COMPOSE_FEATURE_ID,
          cause,
        }),
    }),
};

export const composeServiceType: ServiceType = {
  id: "compose",
  name: "compose",
  base: "l337",
  schema: Schema.Unknown,
  resolve: (input) =>
    Effect.succeed({
      base: "l337",
      normalizedConfig: { ...input.service, type: "compose" },
      features: [{ id: COMPOSE_FEATURE_ID }],
    }),
};
