import { basename } from "node:path";

import { Effect, Schema } from "effect";

import { ServiceFeatureError } from "@lando/sdk/errors";
import {
  AbsolutePath,
  type MountInput,
  PortablePath,
  ServiceName,
  parseShortVolume,
} from "@lando/sdk/schema";
import type { ServiceFeatureContext, ServiceFeatureDefinition, ServiceType } from "@lando/sdk/services";

import { internalEndpointsFromExpose, publishedEndpointsFromPorts } from "./_port-helpers.ts";
import {
  type ClassifiedComposeVolume,
  classifyComposeVolume,
  occupiedTargets,
  resolveBindSource,
} from "./_volume-helpers.ts";

const APP_MOUNT_TARGET = PortablePath.make("/app");

export const COMPOSE_FEATURE_ID = "service-lando.compose" as const;
export const COMPOSE_FEATURE_PRIORITY = 600;

type VolumeMount = {
  readonly type: "bind" | "volume" | "tmpfs";
  readonly source?: string;
  readonly target: string;
  readonly readOnly: boolean;
};

const parseMount = (entry: MountInput, appRoot: string): VolumeMount => {
  if (typeof entry === "string") {
    const parsed = parseShortVolume(entry);
    const source =
      parsed.type === "bind" && parsed.source !== undefined
        ? resolveBindSource(parsed.source, appRoot)
        : parsed.source;
    return {
      type: parsed.type,
      ...(source === undefined ? {} : { source }),
      target: parsed.target,
      readOnly: parsed.readOnly,
    };
  }
  const type = entry.type ?? "bind";
  if (type === "bind" && entry.source === undefined) {
    throw new Error(`Compose bind mount at "${entry.target}" requires a source.`);
  }
  const source =
    type === "bind" && entry.source !== undefined ? resolveBindSource(entry.source, appRoot) : entry.source;
  return {
    type,
    ...(source === undefined ? {} : { source }),
    target: entry.target,
    readOnly: entry.readOnly ?? false,
  };
};

const appNameFor = (ctx: ServiceFeatureContext): string => {
  if (ctx.appName !== undefined && ctx.appName.length > 0) return ctx.appName;
  return basename(ctx.appRoot) || "app";
};

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const applyCompose = (ctx: ServiceFeatureContext): void => {
  const service = ctx.normalizedConfig;
  const hasImage = service.image !== undefined && service.image.length > 0;
  const build = service.build;
  const hasComposeBuild = build !== undefined && "context" in build;
  if (!hasImage && !hasComposeBuild) {
    throw new Error(
      `compose service "${ctx.serviceName}" requires either "image:" or "build:" (Compose build block).`,
    );
  }

  if (hasImage) {
    ctx.setArtifact({ kind: "ref", ref: service.image as string });
  }

  const appName = appNameFor(ctx);
  const optedOutOfAppMount = service.appMount === false;
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

  for (const mount of (service.mounts ?? []).map((entry) => parseMount(entry, ctx.appRoot))) {
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

  if (service.endpoints !== undefined) {
    for (const endpoint of service.endpoints) {
      if (endpoint.protocol === "unix") {
        ctx.addEndpoint({ ...endpoint, socketPath: PortablePath.make(endpoint.socketPath) });
      } else {
        ctx.addEndpoint(endpoint);
      }
    }
  } else {
    for (const endpoint of publishedEndpointsFromPorts(service.ports ?? [], "tcp")) {
      ctx.addEndpoint(endpoint);
    }
    for (const endpoint of internalEndpointsFromExpose(service.expose ?? [], "tcp")) {
      if (endpoint.protocol === "unix") {
        ctx.addEndpoint({ ...endpoint, socketPath: PortablePath.make(endpoint.socketPath) });
      } else {
        ctx.addEndpoint(endpoint);
      }
    }
  }

  if (service.command !== undefined) ctx.setCommand(service.command);
  if (service.entrypoint !== undefined) ctx.setEntrypoint(service.entrypoint);
  if (service.user !== undefined) ctx.setUser(service.user);
  if (service.workingDirectory !== undefined) ctx.setWorkingDirectory(service.workingDirectory);
  for (const dependency of service.dependsOn ?? []) {
    ctx.addDependency({ service: ServiceName.make(dependency.service), condition: "started" });
  }
  for (const [key, value] of Object.entries(service.providers ?? {})) ctx.addExtension(key, value);
  if (tmpfsEntries.length > 0) {
    const existing = service.providers?.compose;
    ctx.addExtension("compose", {
      ...(isRecord(existing) ? existing : {}),
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
