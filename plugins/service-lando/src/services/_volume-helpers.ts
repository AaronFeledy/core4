import { homedir } from "node:os";
import { isAbsolute, resolve as resolvePath } from "node:path";

import { type ComposeVolumeEntry, type ServiceConfig, parseShortVolume } from "@lando/sdk/schema";

const DRIVE_LETTER_PREFIX = /^[A-Za-z]:[\\/]/;

interface ComposeVolumeExtensionEntry {
  readonly type: "bind" | "volume";
  readonly source?: string;
  readonly target: string;
  readonly readOnly: boolean;
  readonly subpath?: string;
  readonly createHostPath?: boolean;
}

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
      };
      readonly extension?: ComposeVolumeExtensionEntry;
    }
  | {
      readonly _tag: "storage";
      readonly target: string;
      readonly storage: { readonly store: string; readonly target: string; readonly readOnly: boolean };
      readonly extension?: ComposeVolumeExtensionEntry;
    }
  | {
      readonly _tag: "tmpfs";
      readonly target: string;
      readonly tmpfs: ComposeTmpfsEntry;
      readonly extension?: undefined;
    };

export const resolveBindSource = (source: string, appRoot: string): string => {
  if (DRIVE_LETTER_PREFIX.test(source)) return source;
  const expanded =
    source === "~" ? homedir() : source.startsWith("~/") ? homedir() + source.slice(1) : source;
  return isAbsolute(expanded) ? expanded : resolvePath(appRoot, expanded);
};

export const kebabTarget = (target: string): string =>
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

const extensionFor = (entry: ComposeVolumeEntry, source?: string): ComposeVolumeExtensionEntry | undefined =>
  entry.subpath === undefined && entry.createHostPath === undefined
    ? undefined
    : {
        type: entry.type === "bind" ? "bind" : "volume",
        ...(source === undefined ? {} : { source }),
        target: entry.target,
        readOnly: entry.readOnly,
        ...(entry.subpath === undefined ? {} : { subpath: entry.subpath }),
        ...(entry.createHostPath === undefined ? {} : { createHostPath: entry.createHostPath }),
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
      const extension = extensionFor(entry, source);
      return {
        _tag: "mount",
        target: entry.target,
        mount: { type: "bind", source, target: entry.target, readOnly: entry.readOnly },
        ...(extension === undefined ? {} : { extension }),
      };
    }
    case "volume": {
      const store =
        entry.source === undefined
          ? `${context.appName}-${context.serviceName}-${kebabTarget(entry.target)}`
          : `${context.appName}-${entry.source}`;
      const extension = extensionFor(entry, entry.source);
      return {
        _tag: "storage",
        target: entry.target,
        storage: { store, target: entry.target, readOnly: entry.readOnly },
        ...(extension === undefined ? {} : { extension }),
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
