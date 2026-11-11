import type { Dirent } from "node:fs";
import { access, readFile, readdir, realpath } from "node:fs/promises";
import { basename, join } from "node:path";
import { APP_LABEL, PROVIDER_LABEL, SCRATCH_LABEL, SERVICE_LABEL } from "@lando/container-runtime/labels";

import { normalizeNamedPipePath } from "@lando/container-runtime/transport";
import { makeLandoPaths } from "@lando/paths";
import type { ProcessRunner } from "@lando/sdk/services";
import type { Context } from "effect";
import { Predicate } from "effect";
import {
  WINDOWS_MANAGED_MACHINE_PIPE,
  httpSocketPath,
  isAbsentEndpoint,
  isNamedPipeSocketPath,
  observeIdleManagedProvider,
  requestJsonOnSocket,
} from "./list-runtime-observation.ts";

export { isNamedPipeSocketPath } from "./list-runtime-observation.ts";

export interface AppsListEntry {
  readonly appId: string;
  readonly appName: string;
  readonly providerId: string;
  readonly appRoot: string;
  readonly services: ReadonlyArray<string>;
  readonly stale?: boolean;
  readonly scratch?: boolean;
}

export interface AppsDiscoveryEvidence {
  readonly apps: ReadonlyArray<AppsListEntry>;
  readonly providerConfirmed: boolean;
  readonly confirmedProviderIds: ReadonlyArray<string>;
  readonly ownedAppIds: ReadonlyArray<string>;
  readonly idleProviderIds?: ReadonlyArray<string>;
}

const LEGACY_PROVIDER_DIRS = ["provider-lando", "provider-docker"] as const;
const APPLIED_PLANS_NAMESPACE = "applied-plans";

export const appliedPlansDirectory = (userDataRoot: string, pluginId = "@lando/provider-lando"): string =>
  join(makeLandoPaths({ userDataRoot }).pluginStateDir(pluginId), APPLIED_PLANS_NAMESPACE);

const APPLIED_PLANS_RECORD = "applied-plans.json";
const GLOBAL_APP_ID = "global";

const uniqueSorted = (values: ReadonlyArray<string>): string[] =>
  [...new Set(values)].sort((left, right) => left.localeCompare(right));

const servicesFromPlan = (services: unknown): string[] => {
  if (Array.isArray(services)) {
    return uniqueSorted(services.filter((value): value is string => typeof value === "string"));
  }
  if (Predicate.isObject(services)) return uniqueSorted(Object.keys(services));
  return [];
};

const providerIdFromPluginRoot = (pluginRoot: string): string =>
  basename(pluginRoot).replace(/^provider-/u, "");

const preferProviderId = (left: string, right: string): string => {
  if (left === "cache" && right !== "cache") return right;
  return left;
};

const preferName = (left: string, right: string, appId: string): string => {
  if (left === appId && right !== appId) return right;
  return left;
};

const preferRoot = (left: string, right: string): string => {
  if (left === "" && right !== "") return right;
  // First nonempty root wins so a longer leftover legacy/cache path cannot replace plugin state.
  return left;
};

export const mergeAppsListEntries = (entries: ReadonlyArray<AppsListEntry>): AppsListEntry[] => {
  const byId = new Map<string, AppsListEntry>();
  for (const entry of entries) {
    const existing = byId.get(entry.appId);
    if (existing === undefined) {
      byId.set(entry.appId, entry);
      continue;
    }
    byId.set(entry.appId, {
      appId: entry.appId,
      appName: preferName(existing.appName, entry.appName, entry.appId),
      providerId: preferProviderId(existing.providerId, entry.providerId),
      appRoot: preferRoot(existing.appRoot, entry.appRoot),
      services: uniqueSorted([...existing.services, ...entry.services]),
      ...(existing.scratch === true || entry.scratch === true ? { scratch: true } : {}),
    });
  }
  const merged = [...byId.values()];
  return merged.filter((entry) => {
    if (entry.providerId !== "cache" || entry.appRoot === "") return true;
    return !merged.some(
      (other) =>
        other.appId !== entry.appId && other.providerId !== "cache" && other.appRoot === entry.appRoot,
    );
  });
};

const planLikeToEntry = (value: unknown, fallbackProvider: string): AppsListEntry | undefined => {
  if (!Predicate.isObject(value)) return undefined;
  const id = value.id;
  const root = value.root;
  if (typeof id !== "string" || typeof root !== "string") return undefined;
  const provider =
    typeof value.provider === "string"
      ? value.provider.replace(/^provider-/u, "")
      : fallbackProvider.replace(/^provider-/u, "");
  const extensions = value.extensions;
  const scratch =
    typeof extensions === "object" &&
    extensions !== null &&
    !Array.isArray(extensions) &&
    "@lando/core/scratch" in extensions;
  return {
    appId: id,
    appName: typeof value.name === "string" ? value.name : id,
    providerId: provider,
    appRoot: root,
    services: servicesFromPlan(value.services),
    ...(scratch ? { scratch: true } : {}),
  };
};

export const decodeAppliedStateFile = (content: string, fallbackProvider: string): AppsListEntry[] => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return [];
  }
  if (!Predicate.isObject(parsed)) return [];

  if ("data" in parsed) {
    const single = planLikeToEntry(parsed.data, fallbackProvider);
    if (single !== undefined) return [single];
    if (Predicate.isObject(parsed.data)) {
      const fromRecord: AppsListEntry[] = [];
      for (const value of Object.values(parsed.data)) {
        const entry = planLikeToEntry(value, fallbackProvider);
        if (entry !== undefined) fromRecord.push(entry);
      }
      if (fromRecord.length > 0) return fromRecord;
    }
  }

  if ("plan" in parsed) {
    const provider = typeof parsed.providerId === "string" ? parsed.providerId : fallbackProvider;
    const entry = planLikeToEntry(parsed.plan, provider);
    return entry === undefined ? [] : [entry];
  }

  const direct = planLikeToEntry(parsed, fallbackProvider);
  return direct === undefined ? [] : [direct];
};

const readJsonPlanFiles = async (dir: string, fallbackProvider: string): Promise<AppsListEntry[]> => {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  const apps: AppsListEntry[] = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    try {
      const content = await readFile(join(dir, name), "utf8");
      apps.push(...decodeAppliedStateFile(content, fallbackProvider));
    } catch {
      // ignore unreadable / corrupt state files
    }
  }
  return apps;
};

const readJsonPlanRecord = async (path: string, fallbackProvider: string): Promise<AppsListEntry[]> => {
  try {
    return decodeAppliedStateFile(await readFile(path, "utf8"), fallbackProvider);
  } catch {
    return [];
  }
};

const listPluginStateRoots = async (pluginsDir: string): Promise<string[]> => {
  let entries: Dirent[];
  try {
    entries = await readdir(pluginsDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const roots: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const full = join(pluginsDir, entry.name);
    if (!entry.name.startsWith("@")) {
      roots.push(full);
      continue;
    }
    let scoped: Dirent[];
    try {
      scoped = await readdir(full, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const child of scoped) {
      if (child.isDirectory()) roots.push(join(full, child.name));
    }
  }
  return roots;
};

export const readAppliedPlansFromUserData = async (userDataRoot: string): Promise<AppsListEntry[]> => {
  const paths = makeLandoPaths({ userDataRoot });
  const apps: AppsListEntry[] = [];
  // Plugin applied-plans are authoritative; leftover providers/*/apps is fallback only.
  for (const pluginRoot of await listPluginStateRoots(paths.pluginsDir)) {
    const providerId = providerIdFromPluginRoot(pluginRoot);
    apps.push(...(await readJsonPlanFiles(join(pluginRoot, APPLIED_PLANS_NAMESPACE), providerId)));
    apps.push(...(await readJsonPlanRecord(join(pluginRoot, APPLIED_PLANS_RECORD), providerId)));
  }
  for (const providerName of LEGACY_PROVIDER_DIRS) {
    apps.push(
      ...(await readJsonPlanFiles(
        join(userDataRoot, "providers", providerName, "apps"),
        providerName.replace(/^provider-/u, ""),
      )),
    );
  }
  return apps;
};

const stringLabels = (value: unknown): Record<string, string> => {
  if (!Predicate.isObject(value)) return {};
  return Object.fromEntries(
    Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  );
};

const labeledResourceEvidence = (
  resources: unknown,
  includeScratch = false,
): { readonly appIds: ReadonlyArray<string>; readonly providerIds: ReadonlyArray<string> } => {
  if (!Array.isArray(resources)) return { appIds: [], providerIds: [] };
  const appIds: string[] = [];
  const providerIds: string[] = [];
  for (const resource of resources) {
    if (!Predicate.isObject(resource)) continue;
    const labels = stringLabels(resource.Labels);
    const appId = labels[APP_LABEL];
    if (appId === undefined || appId === "" || (!includeScratch && labels[SCRATCH_LABEL] === "TRUE"))
      continue;
    appIds.push(appId);
    const providerId = labels[PROVIDER_LABEL];
    if (providerId !== undefined && providerId !== "") providerIds.push(providerId);
  }
  return { appIds: uniqueSorted(appIds), providerIds: uniqueSorted(providerIds) };
};

export const appsFromContainerList = (
  body: unknown,
  options: { readonly globalAppRoot?: string; readonly includeScratch?: boolean } = {},
): AppsListEntry[] => {
  if (!Array.isArray(body)) return [];
  const grouped = new Map<string, { services: Set<string>; providerId: string; scratch: boolean }>();
  for (const container of body) {
    if (!Predicate.isObject(container)) continue;
    if (typeof container.State === "string" && container.State !== "running") continue;
    const labels = stringLabels(container.Labels);
    const appId = labels[APP_LABEL];
    if (appId === undefined || appId === "") continue;
    if (options.includeScratch !== true && labels[SCRATCH_LABEL] === "TRUE") continue;
    const existing = grouped.get(appId) ?? {
      services: new Set<string>(),
      providerId: labels[PROVIDER_LABEL] ?? "lando",
      scratch: false,
    };
    const service = labels[SERVICE_LABEL];
    if (service !== undefined && service !== "") existing.services.add(service);
    if (labels[PROVIDER_LABEL] !== undefined) existing.providerId = labels[PROVIDER_LABEL];
    existing.scratch ||= labels[SCRATCH_LABEL] === "TRUE";
    grouped.set(appId, existing);
  }
  return [...grouped.entries()].map(([appId, info]) => ({
    appId,
    appName: appId,
    providerId: info.providerId,
    appRoot: appId === GLOBAL_APP_ID ? (options.globalAppRoot ?? "") : "",
    services: [...info.services].sort((left, right) => left.localeCompare(right)),
    ...(info.scratch ? { scratch: true } : {}),
  }));
};

const isNpipeDockerHost = (dockerHost: string): boolean => dockerHost.startsWith("npipe:");

export interface ContainerSocketCandidateOptions {
  readonly platform?: NodeJS.Platform;
  readonly env?: Readonly<Record<string, string | undefined>>;
}

export const containerSocketCandidates = (
  userDataRoot: string,
  options: ContainerSocketCandidateOptions = {},
): string[] => {
  const paths = makeLandoPaths({ userDataRoot });
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  // Managed Podman first. Host docker.sock / npipe://./pipe/docker_engine are never defaults.
  const managedSocket = platform === "win32" ? WINDOWS_MANAGED_MACHINE_PIPE : paths.providerSocketPath;
  const candidates = [managedSocket];
  const dockerHost = env.DOCKER_HOST;
  if (dockerHost !== undefined && dockerHost !== "") {
    if (dockerHost.startsWith("unix://")) candidates.push(dockerHost.slice("unix://".length));
    else if (isNpipeDockerHost(dockerHost)) candidates.push(normalizeNamedPipePath(dockerHost));
    else if (dockerHost.startsWith("\\\\.\\pipe\\")) candidates.push(dockerHost);
    else if (dockerHost.startsWith("/")) candidates.push(dockerHost);
  }
  if (platform !== "win32") {
    candidates.push("/run/podman/podman.sock");
    const runtimeDir = env.XDG_RUNTIME_DIR;
    if (runtimeDir !== undefined && runtimeDir !== "") {
      candidates.push(join(runtimeDir, "podman", "podman.sock"));
    }
  }
  return [...new Set(candidates)];
};

const listContainersOnSocket = (socketPath: string): Promise<unknown> => {
  const filters = encodeURIComponent(JSON.stringify({ label: [APP_LABEL] }));
  return requestJsonOnSocket(socketPath, `/containers/json?all=true&filters=${filters}`);
};

const listVolumesOnSocket = (socketPath: string): Promise<unknown> => {
  const filters = encodeURIComponent(JSON.stringify({ label: [APP_LABEL] }));
  return requestJsonOnSocket(socketPath, `/volumes?filters=${filters}`);
};

const providerIdOnSocket = async (socketPath: string, userDataRoot: string): Promise<string> => {
  const paths = makeLandoPaths({ userDataRoot });
  const managedSocket =
    process.platform === "win32" ? WINDOWS_MANAGED_MACHINE_PIPE : paths.providerSocketPath;
  if (httpSocketPath(socketPath) === httpSocketPath(managedSocket)) return "lando";
  const version = JSON.stringify(await requestJsonOnSocket(socketPath, "/version")).toLowerCase();
  return version.includes("podman") ? "podman" : "docker";
};

export const discoverRunningAppsEvidenceFromSockets = async (
  userDataRoot: string,
  sockets: ReadonlyArray<string> = containerSocketCandidates(userDataRoot),
  options: {
    readonly includeScratch?: boolean;
    readonly platform?: NodeJS.Platform;
    readonly env?: Readonly<Record<string, string | undefined>>;
    readonly processRunner?: Pick<Context.Service.Shape<typeof ProcessRunner>, "run">;
  } = {},
): Promise<AppsDiscoveryEvidence> => {
  const paths = makeLandoPaths({ userDataRoot });
  const discoveredApps: AppsListEntry[] = [];
  const listedProviders = new Set<string>();
  const owned = new Set<string>();
  const platform = options.platform ?? process.platform;
  const managedSocket = platform === "win32" ? WINDOWS_MANAGED_MACHINE_PIPE : paths.providerSocketPath;
  let managedEndpointFailed = false;
  for (const socket of sockets) {
    // Named pipes are not filesystem nodes; fs.access ENOENTs even when the pipe is live.
    if (!isNamedPipeSocketPath(socket)) {
      try {
        await access(socket);
      } catch (error) {
        if (httpSocketPath(socket) === httpSocketPath(managedSocket) && !isAbsentEndpoint(error))
          managedEndpointFailed = true;
        continue;
      }
    }
    try {
      const [containers, volumesBody] = await Promise.all([
        listContainersOnSocket(socket),
        listVolumesOnSocket(socket),
      ]);
      const volumes = Predicate.isObject(volumesBody) ? volumesBody.Volumes : undefined;
      if (!Array.isArray(containers) || (volumes !== null && !Array.isArray(volumes)))
        throw new TypeError("Container runtime returned an invalid resource inventory.");
      const apps = appsFromContainerList(containers, {
        globalAppRoot: await realpath(paths.globalAppRoot).catch(() => paths.globalAppRoot),
        ...(options.includeScratch === true ? { includeScratch: true } : {}),
      });
      const containerEvidence = labeledResourceEvidence(containers, options.includeScratch === true);
      const volumeEvidence = labeledResourceEvidence(volumes, options.includeScratch === true);
      const labeledProviderIds = uniqueSorted([
        ...containerEvidence.providerIds,
        ...volumeEvidence.providerIds,
      ]);
      const confirmedProviderIds =
        labeledProviderIds.length > 0 ? labeledProviderIds : [await providerIdOnSocket(socket, userDataRoot)];
      discoveredApps.push(...apps);
      for (const provider of confirmedProviderIds) listedProviders.add(provider);
      for (const id of [...containerEvidence.appIds, ...volumeEvidence.appIds]) owned.add(id);
    } catch (error) {
      if (httpSocketPath(socket) === httpSocketPath(managedSocket) && !isAbsentEndpoint(error))
        managedEndpointFailed = true;
      // Socket present but not a Docker/Podman compat API, or the daemon is mid-start.
    }
  }
  const idleProviderIds =
    listedProviders.has("lando") || managedEndpointFailed
      ? []
      : await observeIdleManagedProvider(paths, options);
  return {
    apps: discoveredApps,
    providerConfirmed: listedProviders.size > 0,
    confirmedProviderIds: [...listedProviders],
    ownedAppIds: [...owned],
    idleProviderIds,
  };
};

export const discoverRunningAppsFromSockets = async (
  userDataRoot: string,
  sockets: ReadonlyArray<string> = containerSocketCandidates(userDataRoot),
  options: { readonly includeScratch?: boolean } = {},
): Promise<ReadonlyArray<AppsListEntry>> =>
  (await discoverRunningAppsEvidenceFromSockets(userDataRoot, sockets, options)).apps;
