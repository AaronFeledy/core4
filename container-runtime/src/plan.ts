import { canonicalJson } from "@lando/sdk/digest";
import type {
  AppPlan,
  AppliedAppPlan,
  InternalEndpoint,
  PublishedEndpoint,
  ServicePlan,
} from "@lando/sdk/schema";
import { containerMountIntent } from "./container-mounts.ts";
import { serviceContainerName } from "./container-name.ts";
import { ContainerPlanError } from "./container-plan-error.ts";
import { CREATE_CONFIG_LABEL, createConfigFingerprint } from "./create-fingerprint.ts";
import {
  containerHealthcheck,
  nativeStartIntervalNs,
  normalizeCommand,
  normalizeEntrypoint,
} from "./create-values.ts";
import { dataRootLabels } from "./data-root-labels.ts";
import { literalServiceEnvironment, requireCurrentCreationPlan } from "./environment-values.ts";
import {
  APP_LABEL,
  APP_ROOT_LABEL,
  HEALTH_START_INTERVAL_LABEL,
  SERVICE_LABEL,
  containerIntegrationLabels,
  scratchLabelsForPlan,
} from "./labels.ts";

import { physicalListenerPorts, physicalPublications } from "./physical-publications.ts";
import { serviceProjectUserMapping } from "./project-user-realization.ts";

export { bindMountStrings, mountSuffix } from "./container-mounts.ts";
export { serviceContainerName } from "./container-name.ts";
export { ContainerPlanError, normalizeCommand, normalizeEntrypoint };

export interface MergeAppliedPlanOptions {
  /**
   * The incoming plan names every service of the app, so it becomes the whole applied record.
   * Without it the record merges, carrying previous services the incoming plan does not name.
   */
  readonly complete?: boolean;
}

/** Retain earlier service metadata when a provider applies only a subset of the app. */
const appliedWithoutEvents = (plan: AppPlan): plan is AppliedAppPlan => !("events" in plan);

export const mergeAppliedPlan = (
  previous: AppPlan | undefined,
  desired: AppPlan,
  options: MergeAppliedPlanOptions = {},
): AppliedAppPlan => {
  const { events: _events, ...projected } = desired;
  const incoming = appliedWithoutEvents(desired) ? desired : projected;
  if (options.complete === true || previous === undefined || previous.id !== incoming.id) return incoming;
  const carried = Object.entries(previous.services).filter(([name]) => !(name in incoming.services));
  // Carried routes are appended when the incoming plan does not name them, so an
  // untouched container keeps the route refs and backend binding it was created
  // with even beside new per-scheme routes for the selected services.
  const routes = [...incoming.routes];
  const routeKeys = routes.map(canonicalJson);
  const resolveCarriedRouteIndex = (route: AppPlan["routes"][number]): number => {
    const key = canonicalJson(route);
    const existing = routeKeys.indexOf(key);
    if (existing >= 0) return existing;
    routes.push(route);
    routeKeys.push(key);
    return routes.length - 1;
  };
  const services = Object.fromEntries(
    carried.map(([name, service]) => {
      if (service.routes.length === 0) return [name, service];
      const carriedRefs = service.routes.flatMap((ref) => {
        const route = previous.routes[ref.index];
        return route === undefined ? [] : [{ index: resolveCarriedRouteIndex(route) }];
      });
      return [name, { ...service, routes: carriedRefs }];
    }),
  );
  const mountedStores = new Set(
    carried.flatMap(([, service]) =>
      service.mounts.flatMap((mount) => (mount.type === "volume" ? [mount.store] : [])),
    ),
  );
  const incomingStores = new Set(incoming.stores.map((store) => store.name));
  const stores = [
    ...incoming.stores,
    ...previous.stores.filter((store) => mountedStores.has(store.name) && !incomingStores.has(store.name)),
  ];
  // A carried service keeps its sync session and policy, so an accelerated record stays complete.
  const carriedNames = new Set(carried.map(([name]) => name));
  const sessionKey = (entry: AppPlan["fileSync"][number]) =>
    `${entry.session.service}/${entry.session.mountKey}`;
  const incomingSessions = new Set(incoming.fileSync.map(sessionKey));
  const fileSync = [
    ...incoming.fileSync,
    ...previous.fileSync.filter(
      (entry) => carriedNames.has(String(entry.session.service)) && !incomingSessions.has(sessionKey(entry)),
    ),
  ];
  const carriedPolicies = Object.entries(previous.fileSyncPolicy?.services ?? {}).filter(([name]) =>
    carriedNames.has(name),
  );
  const merged = {
    ...incoming,
    routes,
    stores,
    fileSync,
    ...(incoming.fileSyncPolicy === undefined || carriedPolicies.length === 0
      ? {}
      : {
          fileSyncPolicy: {
            ...incoming.fileSyncPolicy,
            services: { ...Object.fromEntries(carriedPolicies), ...incoming.fileSyncPolicy.services },
          },
        }),
    services: { ...services, ...incoming.services },
  };
  if (previous.valueModel !== 1 && carried.length > 0) {
    const { valueModel: _valueModel, ...observed } = merged;
    return observed;
  }
  return merged;
};

export const envArrayFromRecord = (environment: Readonly<Record<string, string>>): ReadonlyArray<string> =>
  Object.entries(environment).map(([key, value]) => `${key}=${value}`);

export const serviceEnv = (service: ServicePlan): ReadonlyArray<string> =>
  envArrayFromRecord(literalServiceEnvironment(service));

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
          Object.entries(labels).filter(
            (entry): entry is [string, string] =>
              typeof entry[1] === "string" && entry[0] !== HEALTH_START_INTERVAL_LABEL,
          ),
        )
      : {};
  const startIntervalNs = nativeStartIntervalNs(service);
  const baseLabels = containerIntegrationLabels(
    service.environment,
    {
      ...userLabels,
      [APP_LABEL]: plan.id,
      [APP_ROOT_LABEL]: plan.root,
      [SERVICE_LABEL]: service.name,
      ...scratchLabelsForPlan(plan),
      ...extra,
      ...(startIntervalNs === undefined ? {} : { [HEALTH_START_INTERVAL_LABEL]: String(startIntervalNs) }),
      ...dataRootLabels(plan.identity?.dataRoot),
    },
    service.extensions,
  );
  return { ...baseLabels, [CREATE_CONFIG_LABEL]: createConfigFingerprint(plan, service, baseLabels) };
};

export interface ContainerHostConfigOptions {
  /** Local endpoint copy for the create body. Does not rewrite desired state. */
  readonly endpoints?: ReadonlyArray<InternalEndpoint | PublishedEndpoint>;
}

export const containerPortBindings = (
  endpoints: ReadonlyArray<PublishedEndpoint>,
): Record<string, ReadonlyArray<Record<string, string>>> => {
  const grouped = new Map<string, Array<Record<string, string>>>();
  for (const endpoint of physicalPublications(endpoints)) {
    const key = `${endpoint.port}/${endpoint.transport}`;
    const binding = {
      HostIp: endpoint.bindAddress,
      HostPort: endpoint.hostPort === undefined ? "" : String(endpoint.hostPort),
    };
    const existing = grouped.get(key);
    if (existing === undefined) grouped.set(key, [binding]);
    else existing.push(binding);
  }
  return Object.fromEntries(grouped);
};

export const fingerprintPortBindings = (
  bindings: Record<string, ReadonlyArray<Readonly<Record<string, string>>>>,
): string => {
  const parts: string[] = [];
  for (const [key, list] of Object.entries(bindings)) {
    for (const item of list) {
      parts.push(`${key}@${item.HostIp ?? ""}:${item.HostPort ?? ""}`);
    }
  }
  return [...new Set(parts)].sort().join("|");
};

export const fingerprintPlannedPublishPorts = (endpoints: ReadonlyArray<PublishedEndpoint>): string => {
  if (endpoints.some((endpoint) => endpoint.publication.hostPort === undefined)) return "";
  return fingerprintPortBindings(containerPortBindings(endpoints));
};

export const fingerprintInspectPublishPorts = (inspect: unknown): string => {
  if (typeof inspect !== "object" || inspect === null || !("HostConfig" in inspect)) return "";
  const hostConfig = inspect.HostConfig;
  if (typeof hostConfig !== "object" || hostConfig === null || !("PortBindings" in hostConfig)) return "";
  const bindings = hostConfig.PortBindings;
  if (typeof bindings !== "object" || bindings === null) return "";
  const normalized: Record<string, Array<Record<string, string>>> = {};
  for (const [key, value] of Object.entries(bindings)) {
    if (!Array.isArray(value)) continue;
    normalized[key] = value.flatMap((item) => {
      if (typeof item !== "object" || item === null) return [];
      const hostIp = "HostIp" in item && typeof item.HostIp === "string" ? item.HostIp : "";
      const hostPort = "HostPort" in item && typeof item.HostPort === "string" ? item.HostPort : "";
      return [{ HostIp: hostIp, HostPort: hostPort }];
    });
  }
  return fingerprintPortBindings(normalized);
};

export const containerExposedPorts = (
  endpoints: ReadonlyArray<PublishedEndpoint | InternalEndpoint>,
): Record<string, Record<string, never>> => {
  return Object.fromEntries(physicalListenerPorts(endpoints).map((key) => [key, {}]));
};

export const containerHostConfigFragment = (
  plan: AppPlan,
  service: ServicePlan,
  options: ContainerHostConfigOptions = {},
): Record<string, unknown> => {
  const portBindings = containerPortBindings(
    (options.endpoints ?? service.endpoints).flatMap((endpoint) =>
      endpoint.kind === "published" ? [endpoint] : [],
    ),
  );
  const { binds, mounts, tmpfs } = containerMountIntent(plan, service);
  const extraHosts = service.hostAliases.map(({ hostname, ip }) => `${hostname}:${ip}`);
  return {
    ...(Object.keys(portBindings).length > 0 ? { PortBindings: portBindings } : {}),
    ...(service.init === undefined ? {} : { Init: service.init }),
    ...(binds.length > 0 ? { Binds: binds } : {}),
    ...(mounts.length > 0 ? { Mounts: mounts } : {}),
    ...(Object.keys(tmpfs).length > 0 ? { Tmpfs: tmpfs } : {}),
    ...(extraHosts.length === 0 ? {} : { ExtraHosts: extraHosts }),
    ...(service.projectUser === undefined || serviceProjectUserMapping(service) === "image-renumber"
      ? {}
      : {
          UsernsMode: `keep-id:uid=${service.projectUser.uid},gid=${service.projectUser.gid}`,
        }),
  };
};

/**
 * The create identity an image-renumber plan names directly. A catalog plan
 * keeps its image account name, so it returns undefined and the caller reads
 * the image's configured user; a numeric custom image runs as the host ids
 * that replaced its configured numeric user.
 */
export const projectUserNumericCreateUser = (service: ServicePlan): string | undefined => {
  const projectUser = service.projectUser;
  return projectUser !== undefined &&
    serviceProjectUserMapping(service) === "image-renumber" &&
    /^[0-9]+$/u.test(projectUser.name)
    ? `${projectUser.uid}:${projectUser.gid}`
    : undefined;
};

export interface ContainerCreateBodyOptions {
  readonly name?: string;
  readonly labels?: Readonly<Record<string, string>>;
  readonly hostConfig?: Record<string, unknown>;
  readonly networkingConfig?: Record<string, unknown>;
  readonly onMissingArtifact?: (artifact: ServicePlan["artifact"]) => never;
  readonly environment?: Readonly<Record<string, string>>;
  /**
   * Identity the container is created as. A project-user create always names
   * one explicitly: without it a keep-id container runs as the mapped id
   * instead of the image's own user.
   */
  readonly createUser?: string;
}

const missingArtifact = (artifact: ServicePlan["artifact"]): never => {
  throw new ContainerPlanError("Container create requires a pre-built artifact reference.", { artifact });
};

export const containerCreateBodyFragment = (
  plan: AppPlan,
  service: ServicePlan,
  options: ContainerCreateBodyOptions = {},
): Record<string, unknown> => {
  requireCurrentCreationPlan(plan);
  const artifact = service.artifact;
  if (artifact?.kind !== "ref") {
    return (options.onMissingArtifact ?? missingArtifact)(artifact);
  }
  const healthcheck = containerHealthcheck(service.healthcheck, plan, service);
  const exposedPorts = containerExposedPorts(service.endpoints);

  return {
    ...(options.name === undefined ? {} : { name: options.name }),
    Image: artifact.ref,
    Hostname: serviceContainerName(plan, service.name),
    Env: envArrayFromRecord(options.environment ?? literalServiceEnvironment(service)),
    Cmd: normalizeCommand(service.command),
    Entrypoint: normalizeEntrypoint(service.entrypoint),
    WorkingDir: service.workingDirectory,
    ...((options.createUser ?? service.user) ? { User: options.createUser ?? service.user } : {}),
    ...(healthcheck === undefined ? {} : { Healthcheck: healthcheck }),
    ...(Object.keys(exposedPorts).length > 0 ? { ExposedPorts: exposedPorts } : {}),
    Labels: options.labels ?? commonContainerLabels(plan, service),
    HostConfig: options.hostConfig ?? containerHostConfigFragment(plan, service),
    ...(options.networkingConfig === undefined ? {} : { NetworkingConfig: options.networkingConfig }),
  };
};
