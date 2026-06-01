import {
  type AppPlan,
  type ServicePlan,
  fileSyncVolumeName,
  sameAppMountTarget,
} from "@lando/sdk/schema";

export class ContainerPlanError extends Error {
  readonly _tag = "ContainerPlanError";
  readonly details?: unknown;

  constructor(message: string, details?: unknown) {
    super(message);
    this.name = "ContainerPlanError";
    if (details !== undefined) this.details = details;
  }
}

export const envArrayFromRecord = (environment: Readonly<Record<string, string>>): ReadonlyArray<string> =>
  Object.entries(environment).map(([key, value]) => `${key}=${value}`);

export const serviceEnv = (service: ServicePlan): ReadonlyArray<string> =>
  envArrayFromRecord(service.environment);

export const mountSuffix = (readOnly: boolean): string => (readOnly ? ":ro" : "");

export const normalizeCommand = (
  command: ReadonlyArray<string> | string | undefined,
): Array<string> | undefined => {
  if (command === undefined) return undefined;
  if (typeof command === "string") return ["sh", "-lc", command];
  return [...command];
};

export const normalizeEntrypoint = (
  entrypoint: ReadonlyArray<string> | string | undefined,
): Array<string> | undefined => {
  if (entrypoint === undefined) return undefined;
  if (typeof entrypoint === "string") return [entrypoint];
  return [...entrypoint];
};

export const commonContainerLabels = (
  plan: AppPlan,
  service: ServicePlan,
  extra: Readonly<Record<string, string>> = {},
): Record<string, string> => ({
  "dev.lando.app": plan.id,
  "dev.lando.service": service.name,
  ...extra,
});

export interface ContainerHostConfigOptions {
  readonly onMissingBindMountSource?: (mount: ServicePlan["mounts"][number]) => never;
}

const missingBindMountSource = (mount: ServicePlan["mounts"][number]): never => {
  throw new ContainerPlanError("Container bind mounts require a source.", { mount });
};

export const bindMountStrings = (
  plan: AppPlan,
  service: ServicePlan,
  options: ContainerHostConfigOptions = {},
): ReadonlyArray<string> => {
  const appMounts =
    service.appMount === undefined
      ? []
      : [
          `${
            service.appMount.realization === "accelerated"
              ? fileSyncVolumeName(plan.name, String(service.name), "app-mount")
              : service.appMount.source
          }:${service.appMount.target}${mountSuffix(service.appMount.readOnly)}`,
        ];
  const binds = service.mounts.flatMap((mount, index) => {
    if (mount.type !== "bind") return [];
    if (sameAppMountTarget(service.appMount, mount)) return [];
    if (mount.source === undefined) {
      (options.onMissingBindMountSource ?? missingBindMountSource)(mount);
    }
    const source =
      mount.realization === "accelerated"
        ? fileSyncVolumeName(plan.name, String(service.name), `mount-${index}`)
        : mount.source;
    return [`${source}:${mount.target}${mountSuffix(mount.readOnly)}`];
  });
  return Array.from(new Set([...appMounts, ...binds]));
};

export const containerPortBindings = (service: ServicePlan): Record<string, ReadonlyArray<Record<string, string>>> =>
  Object.fromEntries(
    service.endpoints
      .filter((endpoint) => endpoint.port !== undefined)
      .map((endpoint) => [
        `${endpoint.port}/${endpoint.protocol === "udp" ? "udp" : "tcp"}`,
        [{ HostIp: "127.0.0.1", HostPort: String(endpoint.port) }],
      ]),
  );

export const containerHostConfigFragment = (
  plan: AppPlan,
  service: ServicePlan,
  options: ContainerHostConfigOptions = {},
): Record<string, unknown> => {
  const portBindings = containerPortBindings(service);
  const binds = bindMountStrings(plan, service, options);
  return {
    ...(Object.keys(portBindings).length > 0 ? { PortBindings: portBindings } : {}),
    ...(binds.length > 0 ? { Binds: binds } : {}),
  };
};

export interface ContainerCreateBodyOptions {
  readonly name?: string;
  readonly labels?: Readonly<Record<string, string>>;
  readonly hostConfig?: Record<string, unknown>;
  readonly networkingConfig?: Record<string, unknown>;
  readonly onMissingArtifact?: (artifact: ServicePlan["artifact"]) => never;
}

const missingArtifact = (artifact: ServicePlan["artifact"]): never => {
  throw new ContainerPlanError("Container create requires a pre-built artifact reference.", { artifact });
};

export const containerCreateBodyFragment = (
  plan: AppPlan,
  service: ServicePlan,
  options: ContainerCreateBodyOptions = {},
): Record<string, unknown> => {
  const artifact = service.artifact;
  if (artifact?.kind !== "ref") {
    (options.onMissingArtifact ?? missingArtifact)(artifact);
  }
  const refArtifact = artifact as Extract<NonNullable<ServicePlan["artifact"]>, { readonly kind: "ref" }>;

  return {
    ...(options.name === undefined ? {} : { name: options.name }),
    Image: refArtifact.ref,
    Env: serviceEnv(service),
    Cmd: normalizeCommand(service.command),
    Entrypoint: normalizeEntrypoint(service.entrypoint),
    WorkingDir: service.workingDirectory,
    Labels: options.labels ?? commonContainerLabels(plan, service),
    HostConfig: options.hostConfig ?? containerHostConfigFragment(plan, service),
    ...(options.networkingConfig === undefined ? {} : { NetworkingConfig: options.networkingConfig }),
  };
};
