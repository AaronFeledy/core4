import type { Dirent } from "node:fs";
import { access, readFile, readdir } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { basename, join } from "node:path";

import { makeLandoPaths } from "@lando/paths";

export interface AppsListEntry {
  readonly appId: string;
  readonly appName: string;
  readonly providerId: string;
  readonly appRoot: string;
  readonly services: ReadonlyArray<string>;
}

const LEGACY_PROVIDER_DIRS = ["provider-lando", "provider-docker"] as const;
const APPLIED_PLANS_NAMESPACE = "applied-plans";

export const appliedPlansDirectory = (userDataRoot: string, pluginId = "@lando/provider-lando"): string =>
  join(makeLandoPaths({ userDataRoot }).pluginStateDir(pluginId), APPLIED_PLANS_NAMESPACE);

const APPLIED_PLANS_RECORD = "applied-plans.json";
const APP_LABEL = "dev.lando.app";
const SERVICE_LABEL = "dev.lando.service";
const PROVIDER_LABEL = "dev.lando.provider";
const SCRATCH_LABEL = "dev.lando.scratch";
const GLOBAL_APP_ID = "global";
const CONTAINER_LIST_TIMEOUT_MS = 1500;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const uniqueSorted = (values: ReadonlyArray<string>): string[] =>
  [...new Set(values)].sort((left, right) => left.localeCompare(right));

const servicesFromPlan = (services: unknown): string[] => {
  if (Array.isArray(services)) {
    return uniqueSorted(services.filter((value): value is string => typeof value === "string"));
  }
  if (isRecord(services)) return uniqueSorted(Object.keys(services));
  return [];
};

const providerIdFromPluginRoot = (pluginRoot: string): string =>
  basename(pluginRoot).replace(/^provider-/u, "");

const preferProviderId = (left: string, right: string): string => {
  if (left === "cache" && right !== "cache") return right;
  if (right === "cache" && left !== "cache") return left;
  return left;
};

const preferName = (left: string, right: string, appId: string): string => {
  if (left === appId && right !== appId) return right;
  if (right === appId && left !== appId) return left;
  return left;
};

const preferRoot = (left: string, right: string): string => {
  if (left === "" && right !== "") return right;
  if (right === "" && left !== "") return left;
  return left.length >= right.length ? left : right;
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
  if (!isRecord(value)) return undefined;
  const id = value.id;
  const root = value.root;
  if (typeof id !== "string" || typeof root !== "string") return undefined;
  const provider =
    typeof value.provider === "string"
      ? value.provider.replace(/^provider-/u, "")
      : fallbackProvider.replace(/^provider-/u, "");
  return {
    appId: id,
    appName: typeof value.name === "string" ? value.name : id,
    providerId: provider,
    appRoot: root,
    services: servicesFromPlan(value.services),
  };
};

export const decodeAppliedStateFile = (content: string, fallbackProvider: string): AppsListEntry[] => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return [];
  }
  if (!isRecord(parsed)) return [];

  if ("data" in parsed) {
    const single = planLikeToEntry(parsed.data, fallbackProvider);
    if (single !== undefined) return [single];
    if (isRecord(parsed.data)) {
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
  for (const providerName of LEGACY_PROVIDER_DIRS) {
    apps.push(
      ...(await readJsonPlanFiles(
        join(userDataRoot, "providers", providerName, "apps"),
        providerName.replace(/^provider-/u, ""),
      )),
    );
  }
  for (const pluginRoot of await listPluginStateRoots(paths.pluginsDir)) {
    const providerId = providerIdFromPluginRoot(pluginRoot);
    apps.push(...(await readJsonPlanFiles(join(pluginRoot, APPLIED_PLANS_NAMESPACE), providerId)));
    apps.push(...(await readJsonPlanRecord(join(pluginRoot, APPLIED_PLANS_RECORD), providerId)));
  }
  return apps;
};

const stringLabels = (value: unknown): Record<string, string> => {
  if (!isRecord(value)) return {};
  return Object.fromEntries(
    Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  );
};

export const appsFromContainerList = (
  body: unknown,
  options: { readonly globalAppRoot?: string } = {},
): AppsListEntry[] => {
  if (!Array.isArray(body)) return [];
  const grouped = new Map<string, { services: Set<string>; providerId: string }>();
  for (const container of body) {
    if (!isRecord(container)) continue;
    if (typeof container.State === "string" && container.State !== "running") continue;
    const labels = stringLabels(container.Labels);
    const appId = labels[APP_LABEL];
    if (appId === undefined || appId === "") continue;
    if (labels[SCRATCH_LABEL] === "TRUE") continue;
    const existing = grouped.get(appId) ?? {
      services: new Set<string>(),
      providerId: labels[PROVIDER_LABEL] ?? "lando",
    };
    const service = labels[SERVICE_LABEL];
    if (service !== undefined && service !== "") existing.services.add(service);
    if (labels[PROVIDER_LABEL] !== undefined) existing.providerId = labels[PROVIDER_LABEL];
    grouped.set(appId, existing);
  }
  return [...grouped.entries()].map(([appId, info]) => ({
    appId,
    appName: appId,
    providerId: info.providerId,
    appRoot: appId === GLOBAL_APP_ID ? (options.globalAppRoot ?? "") : "",
    services: [...info.services].sort((left, right) => left.localeCompare(right)),
  }));
};

export const containerSocketCandidates = (userDataRoot: string): string[] => {
  const paths = makeLandoPaths({ userDataRoot });
  // Managed Podman first. Host /var/run/docker.sock is never a default source.
  const candidates = [paths.providerSocketPath];
  const dockerHost = process.env.DOCKER_HOST;
  if (dockerHost !== undefined && dockerHost !== "") {
    if (dockerHost.startsWith("unix://")) candidates.push(dockerHost.slice("unix://".length));
    else if (dockerHost.startsWith("/")) candidates.push(dockerHost);
  }
  candidates.push("/run/podman/podman.sock");
  const runtimeDir = process.env.XDG_RUNTIME_DIR;
  if (runtimeDir !== undefined && runtimeDir !== "") {
    candidates.push(join(runtimeDir, "podman", "podman.sock"));
  }
  return [...new Set(candidates)];
};

const listContainersOnSocket = (socketPath: string): Promise<unknown> =>
  new Promise((resolve, reject) => {
    const filters = encodeURIComponent(JSON.stringify({ label: [APP_LABEL], status: ["running"] }));
    const req = httpRequest(
      {
        socketPath,
        path: `/containers/json?filters=${filters}`,
        method: "GET",
        headers: { Host: "localhost" },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => {
          chunks.push(chunk);
        });
        response.on("end", () => {
          const status = response.statusCode ?? 500;
          if (status < 200 || status >= 300) {
            reject(new Error(`Container list failed with HTTP ${status}.`));
            return;
          }
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
          } catch (cause) {
            reject(cause);
          }
        });
      },
    );
    req.on("error", reject);
    req.setTimeout(CONTAINER_LIST_TIMEOUT_MS, () => {
      req.destroy();
      reject(new Error("Container list timed out."));
    });
    req.end();
  });

export const discoverRunningAppsFromSockets = async (
  userDataRoot: string,
  sockets: ReadonlyArray<string> = containerSocketCandidates(userDataRoot),
): Promise<AppsListEntry[]> => {
  const paths = makeLandoPaths({ userDataRoot });
  for (const socket of sockets) {
    try {
      await access(socket);
    } catch {
      continue;
    }
    try {
      const body = await listContainersOnSocket(socket);
      // First successful list wins so a live managed socket is not mixed with host Docker/Podman.
      return appsFromContainerList(body, { globalAppRoot: paths.globalAppRoot });
    } catch {
      // Socket present but not a Docker/Podman compat API, or the daemon is mid-start.
    }
  }
  return [];
};
