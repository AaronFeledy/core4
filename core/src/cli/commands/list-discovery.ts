import type { Dirent } from "node:fs";
import { access, readFile, readdir } from "node:fs/promises";
import { basename, join } from "node:path";
import {
  APP_LABEL,
  APP_ROOT_LABEL,
  PROVIDER_LABEL,
  SCRATCH_LABEL,
  SERVICE_LABEL,
  VOLUME_INSTANCE_LABEL,
  VOLUME_OWNER_LABEL,
} from "@lando/container-runtime/labels";
import { type AdoptionReceipt, decideDataRootOwnership } from "@lando/container-runtime/native-ownership";

import { normalizeNamedPipePath } from "@lando/container-runtime/transport";
import { makeLandoPaths, sameRealpath } from "@lando/paths";
import { AbsolutePath, LANDO_DATA_ROOT_LABEL } from "@lando/sdk/schema";
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

/** One labeled runtime resource whose app the provider still owns. A missing root blocks by id. */
export interface OwnedAppResource {
  readonly appId: string;
  readonly appRoot?: string;
}

export interface AppsDiscoveryEvidence {
  readonly apps: ReadonlyArray<AppsListEntry>;
  readonly providerConfirmed: boolean;
  readonly confirmedProviderIds: ReadonlyArray<string>;
  readonly ownedResources: ReadonlyArray<OwnedAppResource>;
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

const entryKind = (entry: Pick<AppsListEntry, "appId" | "scratch">): "global" | "scratch" | "user" =>
  entry.appId === GLOBAL_APP_ID ? "global" : entry.scratch === true ? "scratch" : "user";

export const appsListIdentity = (
  entry: Pick<AppsListEntry, "providerId" | "appRoot" | "appId" | "scratch">,
): string => `${entry.providerId}\0${entry.appRoot}\0${entryKind(entry)}\0${entry.appId}`;

const mergeEntries = (existing: AppsListEntry, entry: AppsListEntry): AppsListEntry => ({
  appId: existing.appId,
  appName: preferName(existing.appName, entry.appName, entry.appId),
  providerId: preferProviderId(existing.providerId, entry.providerId),
  appRoot: preferRoot(existing.appRoot, entry.appRoot),
  services: uniqueSorted([...existing.services, ...entry.services]),
  ...(existing.scratch === true || entry.scratch === true ? { scratch: true } : {}),
});

export const mergeAppsListEntries = (entries: ReadonlyArray<AppsListEntry>): AppsListEntry[] => {
  const byIdentity = new Map<string, AppsListEntry>();
  for (const entry of entries) {
    const key = appsListIdentity(entry);
    const existing = byIdentity.get(key);
    byIdentity.set(key, existing === undefined ? entry : mergeEntries(existing, entry));
  }
  // A cache-provider row never names the runtime that owns a root: when a non-cache row has the
  // same app identity, keep that row and fold the cache services into it.
  const cacheRows = [...byIdentity.entries()].filter(([, entry]) => entry.providerId === "cache");
  for (const [key, entry] of cacheRows) {
    const owner = [...byIdentity.entries()].find(
      ([, other]) =>
        other.providerId !== "cache" &&
        other.appId === entry.appId &&
        other.appRoot === entry.appRoot &&
        entryKind(other) === entryKind(entry),
    );
    if (owner === undefined) continue;
    byIdentity.set(owner[0], mergeEntries(owner[1], entry));
    byIdentity.delete(key);
  }
  return [...byIdentity.values()];
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
  rootLabel: typeof APP_ROOT_LABEL | typeof VOLUME_OWNER_LABEL,
  includeScratch = false,
): {
  readonly ownedResources: ReadonlyArray<OwnedAppResource>;
  readonly providerIds: ReadonlyArray<string>;
} => {
  if (!Array.isArray(resources)) return { ownedResources: [], providerIds: [] };
  const owned = new Map<string, OwnedAppResource>();
  const providerIds: string[] = [];
  for (const resource of resources) {
    if (!Predicate.isObject(resource)) continue;
    const labels = stringLabels(resource.Labels);
    const appId = labels[APP_LABEL];
    if (appId === undefined || appId === "" || (!includeScratch && labels[SCRATCH_LABEL] === "TRUE"))
      continue;
    const appRoot = labels[rootLabel];
    const identity = `${appId}\0${appRoot ?? ""}`;
    owned.set(identity, appRoot === undefined || appRoot === "" ? { appId } : { appId, appRoot });
    const providerId = labels[PROVIDER_LABEL];
    if (providerId !== undefined && providerId !== "") providerIds.push(providerId);
  }
  return { ownedResources: [...owned.values()], providerIds: uniqueSorted(providerIds) };
};

export const appsFromContainerList = (
  body: unknown,
  options: { readonly includeScratch?: boolean } = {},
): AppsListEntry[] => {
  if (!Array.isArray(body)) return [];
  const grouped = new Map<
    string,
    {
      appId: string;
      appRoot: string;
      providerId: string;
      scratch: boolean;
      services: Set<string>;
    }
  >();
  for (const container of body) {
    if (!Predicate.isObject(container)) continue;
    if (typeof container.State === "string" && container.State !== "running") continue;
    const labels = stringLabels(container.Labels);
    const appId = labels[APP_LABEL];
    if (appId === undefined || appId === "") continue;
    const scratch = labels[SCRATCH_LABEL] === "TRUE";
    if (options.includeScratch !== true && scratch) continue;
    const providerId = labels[PROVIDER_LABEL] ?? "lando";
    const appRoot = labels[APP_ROOT_LABEL] ?? "";
    const key = appsListIdentity({ providerId, appRoot, appId, scratch });
    const existing = grouped.get(key) ?? {
      appId,
      appRoot,
      providerId,
      scratch,
      services: new Set<string>(),
    };
    const service = labels[SERVICE_LABEL];
    if (service !== undefined && service !== "") existing.services.add(service);
    grouped.set(key, existing);
  }
  return [...grouped.values()].map((info) => ({
    appId: info.appId,
    appName: info.appId,
    providerId: info.providerId,
    appRoot: info.appRoot,
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
    readonly readReceipts?: (
      providerId: string,
      appRoot: AbsolutePath,
    ) => Promise<readonly AdoptionReceipt[]>;
  } = {},
): Promise<AppsDiscoveryEvidence> => {
  const paths = makeLandoPaths({ userDataRoot });
  const dataRoot = paths.roots.userDataRoot;
  const discoveredApps: AppsListEntry[] = [];
  const listedProviders = new Set<string>();
  const owned = new Map<string, OwnedAppResource>();
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
      let socketProvider: string | undefined;
      const receiptsByRoot = new Map<string, readonly AdoptionReceipt[]>();
      const belongsHere = async (resource: unknown, kind: "container" | "volume") => {
        if (!Predicate.isObject(resource)) return false;
        const labels = stringLabels(resource.Labels);
        const label = labels[LANDO_DATA_ROOT_LABEL];
        const canonical = label !== undefined && sameRealpath(label, dataRoot) ? label : dataRoot;
        const root = labels[kind === "container" ? APP_ROOT_LABEL : VOLUME_OWNER_LABEL];
        let receipts: readonly AdoptionReceipt[] = [];
        if (label === undefined && root !== undefined && options.readReceipts !== undefined) {
          socketProvider ??= await providerIdOnSocket(socket, userDataRoot);
          if (labels[PROVIDER_LABEL] !== undefined && labels[PROVIDER_LABEL] !== socketProvider) return false;
          receipts =
            receiptsByRoot.get(root) ?? (await options.readReceipts(socketProvider, AbsolutePath.make(root)));
          receiptsByRoot.set(root, receipts);
        }
        const name =
          kind === "volume" ? resource.Name : Array.isArray(resource.Names) ? resource.Names[0] : undefined;
        return (
          decideDataRootOwnership(
            {
              kind,
              nativeName: typeof name === "string" ? name.replace(/^\//u, "") : "",
              nativeId: typeof resource.Id === "string" ? resource.Id : undefined,
              volumeInstance: labels[VOLUME_INSTANCE_LABEL],
              labels,
            },
            { dataRoot: canonical, receipts },
          ) === "owned"
        );
      };
      const localContainers = [];
      for (const resource of containers) {
        if (!(await belongsHere(resource, "container"))) continue;
        const labels = Predicate.isObject(resource) ? stringLabels(resource.Labels) : {};
        localContainers.push(
          socketProvider !== undefined && labels[PROVIDER_LABEL] === undefined
            ? { ...resource, Labels: { ...labels, [PROVIDER_LABEL]: socketProvider } }
            : resource,
        );
      }
      const localVolumes = [];
      for (const resource of volumes ?? [])
        if (await belongsHere(resource, "volume")) localVolumes.push(resource);
      const apps = appsFromContainerList(localContainers, {
        ...(options.includeScratch === true ? { includeScratch: true } : {}),
      });
      const containerEvidence = labeledResourceEvidence(
        localContainers,
        APP_ROOT_LABEL,
        options.includeScratch === true,
      );
      const volumeEvidence = labeledResourceEvidence(
        localVolumes,
        VOLUME_OWNER_LABEL,
        options.includeScratch === true,
      );
      const labeledProviderIds = uniqueSorted([
        ...containerEvidence.providerIds,
        ...volumeEvidence.providerIds,
      ]);
      const confirmedProviderIds =
        labeledProviderIds.length > 0
          ? labeledProviderIds
          : [socketProvider ?? (await providerIdOnSocket(socket, userDataRoot))];
      discoveredApps.push(...apps);
      for (const provider of confirmedProviderIds) listedProviders.add(provider);
      for (const resource of [...containerEvidence.ownedResources, ...volumeEvidence.ownedResources])
        owned.set(`${resource.appId}\0${resource.appRoot ?? ""}`, resource);
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
    ownedResources: [...owned.values()],
    idleProviderIds,
  };
};

export const discoverRunningAppsFromSockets = async (
  userDataRoot: string,
  sockets: ReadonlyArray<string> = containerSocketCandidates(userDataRoot),
  options: { readonly includeScratch?: boolean } = {},
): Promise<ReadonlyArray<AppsListEntry>> =>
  (await discoverRunningAppsEvidenceFromSockets(userDataRoot, sockets, options)).apps;
