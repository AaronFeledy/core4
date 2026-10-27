import {
  type AppPlan,
  type BindMountPlan,
  type ServicePlan,
  duplicateMountTarget,
  fileSyncVolumeName,
} from "@lando/sdk/schema";
import { ContainerPlanError } from "./container-plan-error.ts";
import { preparedBindSource } from "./file-mode-mounts.ts";
import { requiresLongMountSyntax } from "./mount-syntax.ts";

export const mountSuffix = (readOnly: boolean): string => (readOnly ? ":ro" : "");

/** The planner owns sync identities; renderers must never invent a replacement. */
export const acceleratedMountVolume = (plan: AppPlan, service: ServicePlan, mount: BindMountPlan): string => {
  if (mount.mountKey === undefined) {
    throw new ContainerPlanError("Accelerated bind mounts require a mountKey.", {
      service: service.name,
      target: mount.target,
    });
  }
  return fileSyncVolumeName(plan.name, service.name, mount.mountKey);
};

type ContainerMountObject = {
  readonly Type: "bind" | "volume";
  readonly Source: string;
  readonly Target: string;
  readonly ReadOnly: boolean;
  readonly BindOptions?: { readonly CreateMountpoint: false };
  readonly VolumeOptions?: { readonly Subpath: string };
};

/** One traversal preserves the planner's shallow-to-deep order within each API field. */
export const containerMountIntent = (plan: AppPlan, service: ServicePlan) => {
  const duplicate = duplicateMountTarget(service.mounts);
  if (duplicate !== undefined) {
    throw new ContainerPlanError("Container mounts repeat a target.", {
      service: service.name,
      target: duplicate,
    });
  }
  const binds: string[] = [];
  const mounts: ContainerMountObject[] = [];
  const tmpfs: Record<string, string> = {};
  for (const mount of service.mounts) {
    switch (mount.type) {
      case "bind": {
        const accelerated = mount.realization === "accelerated";
        const source = accelerated ? acceleratedMountVolume(plan, service, mount) : preparedBindSource(mount);
        const strict = !accelerated && mount.createHostPath === false;
        if (strict || requiresLongMountSyntax(mount.target)) {
          mounts.push({
            Type: accelerated ? "volume" : "bind",
            Source: source,
            Target: mount.target,
            ReadOnly: mount.readOnly,
            ...(strict ? { BindOptions: { CreateMountpoint: false } } : {}),
          });
        } else {
          binds.push(`${source}:${mount.target}${mountSuffix(mount.readOnly)}`);
        }
        break;
      }
      case "volume":
        if (mount.subpath !== undefined || requiresLongMountSyntax(mount.target)) {
          mounts.push({
            Type: "volume",
            Source: mount.store,
            Target: mount.target,
            ReadOnly: mount.readOnly,
            ...(mount.subpath === undefined ? {} : { VolumeOptions: { Subpath: mount.subpath } }),
          });
        } else {
          binds.push(`${mount.store}:${mount.target}${mountSuffix(mount.readOnly)}`);
        }
        break;
      case "tmpfs":
        tmpfs[mount.target] = [mount.readOnly ? "ro" : undefined, mount.options].filter(Boolean).join(",");
        break;
      default:
        mount satisfies never;
    }
  }
  return { binds, mounts, tmpfs };
};

export const bindMountStrings = (plan: AppPlan, service: ServicePlan): ReadonlyArray<string> =>
  containerMountIntent(plan, service).binds;
