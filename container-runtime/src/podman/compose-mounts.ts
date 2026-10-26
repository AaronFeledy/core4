import {
  type AppPlan,
  type BindMountPlan,
  type ServicePlan,
  type TmpfsMountPlan,
  type VolumeMountPlan,
  duplicateMountTarget,
  fileSyncVolumeName,
} from "@lando/sdk/schema";
import { mountSuffix } from "../container-mounts.ts";
import { preparedBindSource } from "../file-mode-mounts.ts";
import { requiresLongMountSyntax } from "../mount-syntax.ts";

export interface ComposeBindVolume {
  readonly type: "bind";
  readonly source: string;
  readonly target: string;
  readonly read_only: boolean;
  readonly bind?: { readonly create_host_path: false };
}

export interface ComposeStorageVolume {
  readonly type: "volume";
  readonly source: string;
  readonly target: string;
  readonly read_only: boolean;
  readonly volume?: { readonly subpath: string };
}

export interface ComposeTmpfsVolume {
  readonly type: "tmpfs";
  readonly target: string;
  readonly read_only: boolean;
  readonly tmpfs?: {
    readonly size?: string | number;
    readonly mode?: number;
  };
}

export type ComposeVolumeEntry = string | ComposeBindVolume | ComposeStorageVolume | ComposeTmpfsVolume;

export type ComposeMountFail = (message: string, details?: unknown) => never;

const shortVolumeSpec = (source: string, target: string, readOnly: boolean): string =>
  `${source}:${target}${mountSuffix(readOnly)}`;

/** Plain-target tmpfs as Compose `tmpfs:` list entry: target or target[:ro][,options]. */
export const shortTmpfsSpec = (mount: TmpfsMountPlan): string => {
  const options = [mount.readOnly ? "ro" : undefined, mount.options].filter(Boolean).join(",");
  return options.length === 0 ? mount.target : `${mount.target}:${options}`;
};

/**
 * Colon-target tmpfs as long `volumes:` entry. Only size and mode option tokens are
 * allowed; mode octal text becomes a number. Any other token fails closed.
 */
export const longTmpfsVolume = (mount: TmpfsMountPlan, fail: ComposeMountFail): ComposeTmpfsVolume => {
  const options = mount.options;
  if (options === undefined || options.length === 0) {
    return { type: "tmpfs", target: mount.target, read_only: mount.readOnly };
  }

  let size: string | number | undefined;
  let mode: number | undefined;
  for (const token of options.split(",")) {
    if (token.length === 0) continue;
    const separator = token.indexOf("=");
    const key = separator === -1 ? token : token.slice(0, separator);
    const value = separator === -1 ? undefined : token.slice(separator + 1);
    switch (key) {
      case "size": {
        if (value === undefined || value.length === 0) {
          return fail("Compose long tmpfs size option requires a value.", { target: mount.target, token });
        }
        size = /^[+-]?\d+$/u.test(value) ? Number(value) : value;
        break;
      }
      case "mode": {
        if (value === undefined || !/^[0-7]+$/u.test(value)) {
          return fail("Compose long tmpfs mode option requires octal text.", { target: mount.target, token });
        }
        mode = Number.parseInt(value, 8);
        break;
      }
      default:
        return fail("Compose long tmpfs options may only include size and mode.", {
          target: mount.target,
          token: key,
        });
    }
  }

  return {
    type: "tmpfs",
    target: mount.target,
    read_only: mount.readOnly,
    ...(size === undefined && mode === undefined
      ? {}
      : {
          tmpfs: {
            ...(size === undefined ? {} : { size }),
            ...(mode === undefined ? {} : { mode }),
          },
        }),
  };
};

const bindVolumeEntry = (
  plan: AppPlan,
  service: ServicePlan,
  mount: BindMountPlan,
  fail: ComposeMountFail,
): ComposeVolumeEntry => {
  if (mount.realization === "accelerated") {
    if (mount.mountKey === undefined) {
      return fail("Compose accelerated bind mounts require a mountKey.", {
        service: service.name,
        target: mount.target,
      });
    }
    const source = fileSyncVolumeName(plan.name, service.name, mount.mountKey);
    return requiresLongMountSyntax(mount.target)
      ? { type: "volume", source, target: mount.target, read_only: mount.readOnly }
      : shortVolumeSpec(source, mount.target, mount.readOnly);
  }

  const source = preparedBindSource(mount);
  if (mount.createHostPath === false) {
    return {
      type: "bind",
      source,
      target: mount.target,
      read_only: mount.readOnly,
      bind: { create_host_path: false },
    };
  }

  return requiresLongMountSyntax(mount.target)
    ? { type: "bind", source, target: mount.target, read_only: mount.readOnly }
    : shortVolumeSpec(source, mount.target, mount.readOnly);
};

const storeVolumeEntry = (mount: VolumeMountPlan): ComposeVolumeEntry => {
  if (mount.subpath === undefined && !requiresLongMountSyntax(mount.target)) {
    return shortVolumeSpec(mount.store, mount.target, mount.readOnly);
  }
  return {
    type: "volume",
    source: mount.store,
    target: mount.target,
    read_only: mount.readOnly,
    ...(mount.subpath === undefined ? {} : { volume: { subpath: mount.subpath } }),
  };
};

export interface ServiceComposeMounts {
  readonly volumes: ReadonlyArray<ComposeVolumeEntry>;
  readonly tmpfs: ReadonlyArray<string>;
}

/**
 * One pass over `service.mounts` in plan order: no target dedupe, no index keys.
 * Duplicate targets fail at the provider boundary. Plain tmpfs goes to `tmpfs:`;
 * colon-target tmpfs uses long `volumes:` syntax.
 */
export const serviceComposeMounts = (
  plan: AppPlan,
  service: ServicePlan,
  fail: ComposeMountFail,
): ServiceComposeMounts => {
  const duplicate = duplicateMountTarget(service.mounts);
  if (duplicate !== undefined)
    return fail("Compose mount targets must be unique.", { service: service.name, target: duplicate });
  const volumes: ComposeVolumeEntry[] = [];
  const tmpfs: string[] = [];

  for (const mount of service.mounts) {
    switch (mount.type) {
      case "tmpfs":
        if (requiresLongMountSyntax(mount.target)) {
          volumes.push(longTmpfsVolume(mount, fail));
        } else {
          tmpfs.push(shortTmpfsSpec(mount));
        }
        break;
      case "bind":
        volumes.push(bindVolumeEntry(plan, service, mount, fail));
        break;
      case "volume":
        volumes.push(storeVolumeEntry(mount));
        break;
      default: {
        const unreachable: never = mount;
        return fail("Unsupported Compose mount plan.", { mount: unreachable });
      }
    }
  }

  return { volumes, tmpfs };
};
