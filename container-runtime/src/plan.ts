import {
  type AppPlan,
  type InternalEndpoint,
  type PublishedEndpoint,
  type ServicePlan,
  fileSyncVolumeName,
  sameAppMountTarget,
} from "@lando/sdk/schema";

import { composeConfigBindStrings } from "./compose-configs.ts";

export { composeConfigBindStrings };

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

const containerHealthcheck = (
  healthcheck: ServicePlan["healthcheck"],
): Record<string, unknown> | undefined => {
  if (healthcheck === undefined) return undefined;
  switch (healthcheck.kind) {
    case "none":
      return { Test: ["NONE"] };
    case "command": {
      const command = healthcheck.command;
      if (command === undefined) return undefined;
      return {
        Test: typeof command === "string" ? ["CMD-SHELL", command] : ["CMD", ...command],
        Interval: healthcheck.intervalSeconds * 1_000_000_000,
        Timeout: healthcheck.timeoutSeconds * 1_000_000_000,
        Retries: healthcheck.retries,
        ...(healthcheck.startPeriodSeconds === undefined
          ? {}
          : { StartPeriod: healthcheck.startPeriodSeconds * 1_000_000_000 }),
      };
    }
    case "http":
    case "tcp":
      return undefined;
  }
};

export const commonContainerLabels = (
  plan: AppPlan,
  service: ServicePlan,
  extra: Readonly<Record<string, string>> = {},
): Record<string, string> => {
  const compose = service.extensions.compose;
  const labels =
    typeof compose === "object" && compose !== null && !Array.isArray(compose) && "labels" in compose
      ? compose.labels
      : undefined;
  const userLabels =
    typeof labels === "object" && labels !== null && !Array.isArray(labels)
      ? Object.fromEntries(
          Object.entries(labels).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
        )
      : {};
  return {
    ...userLabels,
    "dev.lando.app": plan.id,
    "dev.lando.service": service.name,
    ...extra,
  };
};

export interface ContainerHostConfigOptions {
  readonly onMissingBindMountSource?: (mount: ServicePlan["mounts"][number]) => never;
}

const missingBindMountSource = (mount: ServicePlan["mounts"][number]): never => {
  throw new ContainerPlanError("Container bind mounts require a source.", { mount });
};

interface ContainerBindMountObject {
  readonly Type: "bind";
  readonly Source: string;
  readonly Target: string;
  readonly ReadOnly: boolean;
  readonly BindOptions: { readonly CreateMountpoint: false };
}

interface ContainerVolumeMountObject {
  readonly Type: "volume";
  readonly Source: string;
  readonly Target: string;
  readonly ReadOnly: boolean;
  readonly VolumeOptions: { readonly Subpath: string };
}

type ContainerMountObject = ContainerBindMountObject | ContainerVolumeMountObject;

const containerMountObjects = (
  service: ServicePlan,
  options: ContainerHostConfigOptions = {},
): ReadonlyArray<ContainerMountObject> => [
  ...service.mounts.flatMap((mount): ReadonlyArray<ContainerBindMountObject> => {
    if (sameAppMountTarget(service.appMount, mount)) return [];
    if (mount.type !== "bind" || mount.realization !== "passthrough" || mount.createHostPath !== false) {
      return [];
    }
    if (mount.source === undefined)
      return (options.onMissingBindMountSource ?? missingBindMountSource)(mount);
    return [
      {
        Type: "bind",
        Source: mount.source,
        Target: mount.target,
        ReadOnly: mount.readOnly,
        BindOptions: { CreateMountpoint: false },
      },
    ];
  }),
  ...service.storage.flatMap(
    (storeMount): ReadonlyArray<ContainerVolumeMountObject> =>
      storeMount.subpath === undefined
        ? []
        : [
            {
              Type: "volume",
              Source: storeMount.store,
              Target: storeMount.target,
              ReadOnly: storeMount.readOnly,
              VolumeOptions: { Subpath: storeMount.subpath },
            },
          ],
  ),
];

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
    if (mount.realization === "passthrough" && mount.createHostPath === false) return [];
    const source =
      mount.realization === "accelerated"
        ? fileSyncVolumeName(plan.name, String(service.name), `mount-${index}`)
        : mount.source;
    return [`${source}:${mount.target}${mountSuffix(mount.readOnly)}`];
  });
  const storage = service.storage.flatMap((storeMount) =>
    storeMount.subpath === undefined
      ? [`${storeMount.store}:${storeMount.target}${mountSuffix(storeMount.readOnly)}`]
      : [],
  );
  return Array.from(
    new Set([...appMounts, ...binds, ...storage, ...composeConfigBindStrings(plan, service)]),
  );
};

export const containerPortBindings = (
  endpoints: ReadonlyArray<PublishedEndpoint>,
): Record<string, ReadonlyArray<Record<string, string>>> => {
  const grouped = new Map<string, Array<Record<string, string>>>();
  for (const endpoint of endpoints) {
    const key = `${endpoint.port}/${endpoint.protocol === "udp" ? "udp" : "tcp"}`;
    const binding = {
      HostIp: endpoint.publication.bindAddress ?? "127.0.0.1",
      HostPort: endpoint.publication.hostPort === undefined ? "" : String(endpoint.publication.hostPort),
    };
    const existing = grouped.get(key);
    if (existing === undefined) grouped.set(key, [binding]);
    else existing.push(binding);
  }
  return Object.fromEntries(grouped);
};

export const containerExposedPorts = (
  endpoints: ReadonlyArray<PublishedEndpoint | InternalEndpoint>,
): Record<string, Record<string, never>> => {
  const ports: Record<string, Record<string, never>> = {};
  for (const endpoint of endpoints) {
    if (endpoint.protocol === "unix") continue;
    const key = `${endpoint.port}/${endpoint.protocol === "udp" ? "udp" : "tcp"}`;
    ports[key] = {};
  }
  return ports;
};

export const containerHostConfigFragment = (
  plan: AppPlan,
  service: ServicePlan,
  options: ContainerHostConfigOptions = {},
): Record<string, unknown> => {
  const portBindings = containerPortBindings(
    service.endpoints.flatMap((endpoint) => (endpoint._tag === "published" ? [endpoint] : [])),
  );
  const binds = bindMountStrings(plan, service, options);
  const mounts = containerMountObjects(service, options);
  return {
    ...(Object.keys(portBindings).length > 0 ? { PortBindings: portBindings } : {}),
    ...(binds.length > 0 ? { Binds: binds } : {}),
    ...(mounts.length > 0 ? { Mounts: mounts } : {}),
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
    return (options.onMissingArtifact ?? missingArtifact)(artifact);
  }
  const healthcheck = containerHealthcheck(service.healthcheck);
  const exposedPorts = containerExposedPorts(service.endpoints);

  return {
    ...(options.name === undefined ? {} : { name: options.name }),
    Image: artifact.ref,
    Env: serviceEnv(service),
    Cmd: normalizeCommand(service.command),
    Entrypoint: normalizeEntrypoint(service.entrypoint),
    WorkingDir: service.workingDirectory,
    ...(service.user === undefined || service.user === "" ? {} : { User: service.user }),
    ...(healthcheck === undefined ? {} : { Healthcheck: healthcheck }),
    ...(Object.keys(exposedPorts).length > 0 ? { ExposedPorts: exposedPorts } : {}),
    Labels: options.labels ?? commonContainerLabels(plan, service),
    HostConfig: options.hostConfig ?? containerHostConfigFragment(plan, service),
    ...(options.networkingConfig === undefined ? {} : { NetworkingConfig: options.networkingConfig }),
  };
};
