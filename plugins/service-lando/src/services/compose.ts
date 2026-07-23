import { homedir } from "node:os";
import { basename, isAbsolute, resolve as resolvePath } from "node:path";

import { Effect, Schema } from "effect";

import { ServiceFeatureError } from "@lando/sdk/errors";
import { AbsolutePath, type MountInput, PortablePath, ServiceName } from "@lando/sdk/schema";
import type { ServiceFeatureContext, ServiceFeatureDefinition, ServiceType } from "@lando/sdk/services";

import { parsePublishedPort, publicationFor } from "./_port-helpers.ts";

const APP_MOUNT_TARGET = PortablePath.make("/app");

export const COMPOSE_FEATURE_ID = "service-lando.compose" as const;
export const COMPOSE_FEATURE_PRIORITY = 600;

type VolumeMount = {
  readonly type: "bind" | "volume" | "tmpfs";
  readonly source?: string;
  readonly target: string;
  readonly readOnly: boolean;
};

// Windows drive-letter prefix ("C:\" or "C:/") whose ":" is a path char, not a Compose separator.
const DRIVE_LETTER_PREFIX = /^[A-Za-z]:[\\/]/;

// Split on ":" but keep a leading drive letter attached: "C:\src:/app:ro" -> ["C:\src","/app","ro"].
const splitMountEntry = (entry: string): ReadonlyArray<string> => {
  if (!DRIVE_LETTER_PREFIX.test(entry)) return entry.split(":");
  const driveLetter = entry.slice(0, 2);
  const [firstSegment, ...rest] = entry.slice(2).split(":");
  return [`${driveLetter}${firstSegment ?? ""}`, ...rest];
};

const resolveBindSource = (source: string, appRoot: string): string => {
  if (DRIVE_LETTER_PREFIX.test(source)) return source;
  const expanded =
    source === "~" ? homedir() : source.startsWith("~/") ? homedir() + source.slice(1) : source;
  return isAbsolute(expanded) ? expanded : resolvePath(appRoot, expanded);
};

const parseVolumeShortForm = (entry: string, appRoot: string): VolumeMount => {
  const parts = splitMountEntry(entry);
  if (parts.length < 2 || parts.length > 3) {
    throw new Error(
      `Invalid compose volume entry "${entry}". Expected short form "<source>:<target>[:ro|rw]".`,
    );
  }
  const [rawSource, rawTarget, mode] = parts as [string, string, string | undefined];
  if (rawSource.length === 0 || rawTarget.length === 0) {
    throw new Error(`Invalid compose volume entry "${entry}". Source and target must be non-empty.`);
  }
  const readOnly = mode === "ro";
  if (mode !== undefined && mode !== "ro" && mode !== "rw") {
    throw new Error(`Invalid compose volume mode "${mode}" in "${entry}". Allowed: ro, rw.`);
  }
  const isPathLike =
    rawSource.startsWith(".") ||
    rawSource.startsWith("/") ||
    rawSource.startsWith("~") ||
    DRIVE_LETTER_PREFIX.test(rawSource);
  if (isPathLike) {
    return { type: "bind", source: resolveBindSource(rawSource, appRoot), target: rawTarget, readOnly };
  }
  return { type: "volume", source: rawSource, target: rawTarget, readOnly };
};

const parseMount = (entry: MountInput, appRoot: string): VolumeMount => {
  if (typeof entry === "string") return parseVolumeShortForm(entry, appRoot);
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

const applyCompose = (ctx: ServiceFeatureContext): void => {
  const service = ctx.normalizedConfig;
  const hasImage = service.image !== undefined && service.image.length > 0;
  const hasBuild = service.composeBuild !== undefined;
  if (!hasImage && !hasBuild) {
    throw new Error(
      `compose service "${ctx.serviceName}" requires either "image:" or "composeBuild:" (Compose build block).`,
    );
  }
  if (hasImage && hasBuild) {
    throw new Error(
      `compose service "${ctx.serviceName}" must declare exactly one of "image:" or "composeBuild:", not both.`,
    );
  }
  if (service.build !== undefined) {
    throw new Error(
      `compose service "${ctx.serviceName}" does not accept Lando "build:" (artifact/app scripts). Use "composeBuild:" with Compose-spec fields, or move provider-specific build to "providers.<id>".`,
    );
  }

  const composeBuild = service.composeBuild;
  if (hasImage) {
    ctx.setArtifact({ kind: "ref", ref: service.image as string });
  } else if (composeBuild !== undefined) {
    ctx.setArtifact({
      kind: "build",
      context: AbsolutePath.make(
        isAbsolute(composeBuild.context)
          ? composeBuild.context
          : resolvePath(ctx.appRoot, composeBuild.context),
      ),
      ...(composeBuild.dockerfile === undefined ? {} : { spec: PortablePath.make(composeBuild.dockerfile) }),
      ...(composeBuild.args === undefined ? {} : { args: composeBuild.args }),
      ...(composeBuild.target === undefined ? {} : { target: composeBuild.target }),
    });
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

  for (const volume of (service.volumes ?? []).map((entry) => parseVolumeShortForm(entry, ctx.appRoot))) {
    if (volume.type === "bind") {
      ctx.addMount({
        type: "bind",
        source: volume.source,
        target: PortablePath.make(volume.target),
        readOnly: volume.readOnly,
      });
    } else if (volume.type === "volume") {
      ctx.addStorage({
        store: `${appName}-${volume.source}`,
        target: PortablePath.make(volume.target),
        readOnly: volume.readOnly,
      });
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
    for (const portEntry of service.ports ?? []) {
      const parsed = parsePublishedPort(portEntry);
      ctx.addEndpoint({
        _tag: "published",
        port: parsed.port,
        protocol: parsed.protocol,
        name: ctx.serviceName,
        publication: publicationFor(parsed),
      });
    }
  }

  if (service.command !== undefined) ctx.setCommand(service.command);
  if (service.entrypoint !== undefined) ctx.setEntrypoint(service.entrypoint);
  if (service.user !== undefined) ctx.setUser(service.user);
  if (service.workingDirectory !== undefined) ctx.setWorkingDirectory(service.workingDirectory);
  for (const dependency of service.dependsOn ?? []) {
    ctx.addDependency({ service: ServiceName.make(dependency), condition: "started" });
  }
  for (const [key, value] of Object.entries(service.providers ?? {})) ctx.addExtension(key, value);
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
