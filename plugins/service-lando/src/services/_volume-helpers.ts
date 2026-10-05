import { homedir } from "node:os";
import { isAbsolute, resolve as resolvePath, win32 } from "node:path";

import {
  AbsolutePath,
  type ComposeVolumeEntry,
  type MountInput,
  PortablePath,
  type ServiceConfig,
  parseShortVolume,
} from "@lando/sdk/schema";
import type { ServiceAppMountIntent, ServiceFeatureContext } from "@lando/sdk/services";

const DRIVE_LETTER_PREFIX = /^[A-Za-z]:[\\/]/;

export const mountAppRoot = (
  ctx: ServiceFeatureContext,
  options: Partial<Pick<ServiceAppMountIntent, "target" | "excludes" | "readOnly">> & {
    readonly realization?: "passthrough";
  } = {},
): void => {
  const target = options.target ?? PortablePath.make("/app");
  const readOnly = options.readOnly ?? false;
  const realization = options.realization === undefined ? {} : { realization: options.realization };
  ctx.setAppMount({
    source: AbsolutePath.make(ctx.appRoot),
    target,
    readOnly,
    excludes: [...(options.excludes ?? [])],
    includes: [],
    ...realization,
  });
  ctx.addMount({
    type: "bind",
    source: ctx.appRoot,
    target,
    readOnly,
    ...realization,
  });
};

interface ComposeTmpfsEntry {
  readonly target: string;
  readonly read_only?: true;
  readonly size?: number | string;
  readonly mode?: number;
}

export type ClassifiedComposeVolume =
  | {
      readonly _tag: "mount";
      readonly target: string;
      readonly mount: {
        readonly type: "bind";
        readonly source: string;
        readonly target: string;
        readonly readOnly: boolean;
        readonly createHostPath?: boolean;
      };
    }
  | {
      readonly _tag: "storage";
      readonly target: string;
      readonly storage: {
        readonly store: string;
        readonly target: string;
        readonly readOnly: boolean;
        readonly subpath?: string;
      };
    }
  | {
      readonly _tag: "tmpfs";
      readonly target: string;
      readonly tmpfs: ComposeTmpfsEntry;
    };

export const resolveBindSource = (source: string, appRoot: string): string => {
  if (DRIVE_LETTER_PREFIX.test(source)) return source;
  const expanded =
    source === "~" ? homedir() : source.startsWith("~/") ? homedir() + source.slice(1) : source;
  // Absolute sources (including VM-side paths such as /var/run/docker.sock)
  // pass through unchanged; only relative sources resolve against a Windows root.
  if (isAbsolute(expanded) || win32.isAbsolute(expanded)) return expanded;
  if (DRIVE_LETTER_PREFIX.test(appRoot) || appRoot.startsWith("\\\\")) {
    return win32.resolve(appRoot, expanded);
  }
  return resolvePath(appRoot, expanded);
};

export const addServerConfigMount = (
  ctx: ServiceFeatureContext,
  target: Parameters<ServiceFeatureContext["addMount"]>[0]["target"],
): boolean => {
  const server = ctx.normalizedConfig.config?.server;
  if (server === undefined || server.length === 0) return false;
  ctx.addMount({
    type: "bind",
    source: resolveBindSource(server, ctx.appRoot),
    target,
    readOnly: true,
  });
  return true;
};

export const parseServiceMount = (
  entry: MountInput,
  appRoot: string,
): {
  readonly type: "bind" | "volume" | "tmpfs";
  readonly source?: string;
  readonly target: string;
  readonly readOnly: boolean;
} => {
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
    throw new Error(`Bind mount at "${entry.target}" requires a source.`);
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

const kebabTarget = (target: string): string =>
  target
    .split("/")
    .filter((segment) => segment.length > 0)
    .join("-");

export const occupiedTargets = (service: ServiceConfig, appMountTarget: string): ReadonlySet<string> => {
  const targets = new Set<string>();
  if (service.appMount !== false) {
    targets.add(typeof service.appMount === "object" ? service.appMount.target : appMountTarget);
  }
  for (const mount of service.mounts ?? []) {
    targets.add(typeof mount === "string" ? parseShortVolume(mount).target : mount.target);
  }
  for (const storage of service.storage ?? []) {
    targets.add(typeof storage === "string" ? storage : storage.target);
  }
  return targets;
};

export const classifyComposeVolume = (
  entry: ComposeVolumeEntry,
  context: { readonly appRoot: string; readonly appName: string; readonly serviceName: string },
): ClassifiedComposeVolume => {
  switch (entry.type) {
    case "bind": {
      if (entry.source === undefined)
        throw new Error(`Compose bind mount at "${entry.target}" requires a source.`);
      const source = resolveBindSource(entry.source, context.appRoot);
      return {
        _tag: "mount",
        target: entry.target,
        mount: {
          type: "bind",
          source,
          target: entry.target,
          readOnly: entry.readOnly,
          ...(entry.createHostPath === false ? { createHostPath: false } : {}),
        },
      };
    }
    case "volume": {
      const store =
        entry.source === undefined
          ? `${context.appName}-${context.serviceName}-${kebabTarget(entry.target)}`
          : `${context.appName}-${entry.source}`;
      return {
        _tag: "storage",
        target: entry.target,
        storage: {
          store,
          target: entry.target,
          readOnly: entry.readOnly,
          ...(entry.subpath === undefined ? {} : { subpath: entry.subpath }),
        },
      };
    }
    case "tmpfs":
      return {
        _tag: "tmpfs",
        target: entry.target,
        tmpfs: {
          target: entry.target,
          ...(entry.readOnly ? { read_only: true } : {}),
          ...(entry.tmpfs?.size === undefined ? {} : { size: entry.tmpfs.size }),
          ...(entry.tmpfs?.mode === undefined ? {} : { mode: entry.tmpfs.mode }),
        },
      };
    default: {
      const exhaustive: never = entry.type;
      throw new Error(`Unsupported Compose volume type: ${exhaustive}`);
    }
  }
};
