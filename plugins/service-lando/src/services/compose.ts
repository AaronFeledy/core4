import { homedir } from "node:os";
import { isAbsolute, resolve as resolvePath } from "node:path";

import { AbsolutePath, PortablePath, ProviderId, ServiceName } from "@lando/sdk/schema";
import type { ServiceTypeShape } from "@lando/sdk/services";

import { decodeServicePlan } from "./_schema-helpers.ts";
import { appNameFor, buildLandoEnv } from "./env.ts";

const APP_MOUNT_TARGET = PortablePath.make("/app");

type VolumeMount = {
  readonly type: "bind" | "volume" | "tmpfs";
  readonly source?: string;
  readonly target: string;
  readonly readOnly: boolean;
};

const parseVolumeShortForm = (entry: string, appRoot: string): VolumeMount => {
  const parts = entry.split(":");
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
  const isPathLike = rawSource.startsWith(".") || rawSource.startsWith("/") || rawSource.startsWith("~");
  if (isPathLike) {
    // Docker Compose expands `~` to the user's home directory at runtime.
    // Node's `path.resolve` does NOT expand `~`, so we must do it ourselves
    // before resolving — otherwise `~/data` becomes `<appRoot>/~/data`.
    // We only handle `~` alone and `~/...`; `~user/...` is unsupported by
    // Docker Compose itself and is out of scope.
    const expanded =
      rawSource === "~" ? homedir() : rawSource.startsWith("~/") ? homedir() + rawSource.slice(1) : rawSource;
    const source = isAbsolute(expanded) ? expanded : resolvePath(appRoot, expanded);
    return { type: "bind", source, target: rawTarget, readOnly };
  }
  return { type: "volume", source: rawSource, target: rawTarget, readOnly };
};

const parsePortShortForm = (entry: string): { port: number; protocol: "tcp" | "udp" } => {
  const parts = entry.split(":");
  const last = parts[parts.length - 1];
  if (last === undefined) {
    throw new Error(`Invalid compose port entry "${entry}".`);
  }
  const [portPart, protoPart] = last.split("/");
  const port = Number(portPart);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`Invalid compose port "${entry}". Expected positive integer port.`);
  }
  const protocol = protoPart === "udp" ? "udp" : "tcp";
  return { port, protocol };
};

export const composeServiceType: ServiceTypeShape = {
  id: "compose",
  toServicePlan: (input) => {
    const {
      name,
      service,
      appRoot,
      provider = ProviderId.make("lando"),
      primary = false,
      metadata,
      host,
    } = input;
    const hasImage = service.image !== undefined && service.image.length > 0;
    const hasBuild = service.composeBuild !== undefined;
    if (!hasImage && !hasBuild) {
      throw new Error(
        `compose service "${name}" requires either "image:" or "composeBuild:" (Compose build block).`,
      );
    }
    if (hasImage && hasBuild) {
      throw new Error(
        `compose service "${name}" must declare exactly one of "image:" or "composeBuild:", not both.`,
      );
    }
    if (service.build !== undefined) {
      throw new Error(
        `compose service "${name}" does not accept Lando "build:" (artifact/app scripts). Use "composeBuild:" with Compose-spec fields, or move provider-specific build to "providers.<id>".`,
      );
    }

    const appName = appNameFor(input);
    const composeBuild = service.composeBuild;
    const buildContext = composeBuild?.context;
    const artifact =
      hasImage || buildContext === undefined
        ? { kind: "ref" as const, ref: service.image as string }
        : {
            kind: "build" as const,
            context: AbsolutePath.make(
              isAbsolute(buildContext) ? buildContext : resolvePath(appRoot, buildContext),
            ),
            ...(composeBuild?.dockerfile === undefined
              ? {}
              : { spec: PortablePath.make(composeBuild.dockerfile) }),
            ...(composeBuild?.args === undefined ? {} : { args: composeBuild.args }),
            ...(composeBuild?.target === undefined ? {} : { target: composeBuild.target }),
          };

    const parsedVolumes = (service.volumes ?? []).map((entry) => parseVolumeShortForm(entry, appRoot));
    const volumeBindMounts = parsedVolumes
      .filter((volume) => volume.type === "bind")
      .map((volume) => ({
        type: "bind" as const,
        source: volume.source as string,
        target: volume.target,
        readOnly: volume.readOnly,
        realization: "passthrough" as const,
      }));
    const storage = parsedVolumes
      .filter((volume) => volume.type === "volume")
      .map((volume) => ({
        store: `${appName}-${volume.source as string}`,
        target: volume.target,
        readOnly: volume.readOnly,
      }));

    const endpoints = (service.ports ?? []).map((portEntry) => {
      const parsed = parsePortShortForm(portEntry);
      return { port: parsed.port, protocol: parsed.protocol, name };
    });

    const optedOutOfAppMount = service.appMount === false;
    const appMount = optedOutOfAppMount
      ? undefined
      : {
          source: AbsolutePath.make(appRoot),
          target: APP_MOUNT_TARGET,
          readOnly: false,
          excludes: [],
          includes: [],
          realization: "passthrough" as const,
        };
    const appRootBindMount = optedOutOfAppMount
      ? []
      : [
          {
            type: "bind" as const,
            source: appRoot,
            target: APP_MOUNT_TARGET,
            readOnly: false,
            realization: "passthrough" as const,
          },
        ];
    const mounts = [...appRootBindMount, ...volumeBindMounts];

    const environment = buildLandoEnv({
      serviceName: name,
      serviceType: "compose",
      appName,
      ...(optedOutOfAppMount ? {} : { appPaths: { appRoot: "/app", projectMount: "/app" } }),
      host,
      userEnv: service.environment ?? {},
    });

    return decodeServicePlan({
      name: ServiceName.make(name),
      type: "compose",
      provider,
      primary: service.primary ?? primary,
      artifact,
      command: service.command,
      entrypoint: service.entrypoint,
      environment,
      user: service.user,
      workingDirectory: service.workingDirectory,
      appMount,
      mounts,
      storage,
      endpoints,
      routes: [],
      dependsOn: (service.dependsOn ?? []).map((dependency) => ({
        service: ServiceName.make(dependency),
        condition: "started",
      })),
      hostAliases: [],
      metadata,
      extensions: service.providers ?? {},
    });
  },
};
