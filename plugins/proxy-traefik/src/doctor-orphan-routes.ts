import type { Dirent } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

import { globalAppRootPath, makeLandoPaths } from "@lando/paths";
import type {
  PluginDoctorCheckContribution,
  PluginDoctorCheckInput,
  PluginDoctorReport,
} from "@lando/sdk/plugins";
import { Effect } from "effect";

import { dynamicConfigDir, isRouteFileName, routeFileAppId } from "./proxy-paths.ts";
import type { ProxyPaths } from "./proxy-types.ts";

const APPLIED_PLANS_NAMESPACE = "applied-plans";
const APPLIED_PLANS_RECORD = "applied-plans.json";
const CONTEXT_VALUE_MAX = 2_000;

const clipContext = (value: string): string =>
  value.length <= CONTEXT_VALUE_MAX ? value : value.slice(0, CONTEXT_VALUE_MAX);

export const collectAppIdsFromAppliedState = (value: unknown): ReadonlyArray<string> => {
  const ids = new Set<string>();
  const visit = (node: unknown): void => {
    if (typeof node !== "object" || node === null) return;
    if ("id" in node && typeof node.id === "string" && node.id.length > 0) ids.add(node.id);
    if ("data" in node) {
      const data = (node as { data: unknown }).data;
      if (Array.isArray(data)) {
        for (const entry of data) visit(entry);
      } else if (typeof data === "object" && data !== null) {
        if ("id" in data) visit(data);
        else for (const entry of Object.values(data)) visit(entry);
      }
    }
    if ("plan" in node) visit((node as { plan: unknown }).plan);
  };
  visit(value);
  return [...ids];
};

const pluginStateRoots = async (pluginsDir: string): Promise<ReadonlyArray<string>> => {
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

const idsFromJsonFile = async (path: string): Promise<ReadonlyArray<string>> => {
  try {
    return collectAppIdsFromAppliedState(JSON.parse(await readFile(path, "utf8")));
  } catch {
    return [];
  }
};

export const listKnownAppIdsFromUserData = async (userDataRoot: string): Promise<ReadonlySet<string>> => {
  const ids = new Set<string>();
  const pluginsDir = makeLandoPaths({ userDataRoot }).pluginsDir;
  for (const pluginRoot of await pluginStateRoots(pluginsDir)) {
    const directory = join(pluginRoot, APPLIED_PLANS_NAMESPACE);
    let names: string[];
    try {
      names = await readdir(directory);
    } catch {
      names = [];
    }
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      for (const id of await idsFromJsonFile(join(directory, name))) ids.add(id);
    }
    for (const id of await idsFromJsonFile(join(pluginRoot, APPLIED_PLANS_RECORD))) ids.add(id);
  }
  return ids;
};

const readRouteFileNames = (paths: ProxyPaths): Effect.Effect<ReadonlyArray<string>> =>
  Effect.tryPromise(() => readdir(dynamicConfigDir(paths))).pipe(
    Effect.map((names) => names.filter((name) => isRouteFileName(name))),
    Effect.catch(() => Effect.succeed<ReadonlyArray<string>>([])),
  );

const orphanReport = (slugs: ReadonlyArray<string>): PluginDoctorReport => ({
  name: "orphan-route-files",
  status: "warn",
  severity: "warn",
  runtimeStatus: "orphan-route-files",
  runtime: { running: true },
  context: {
    proxyId: "traefik",
    orphanCount: String(slugs.length),
    slugs: clipContext(slugs.join(", ")),
  },
  solutions: [
    {
      kind: "manual",
      description:
        "A router file remains for an app Lando no longer knows. Start that app to republish its routes, or stop the global router if the app is gone.",
    },
  ],
});

export type KnownAppIdReader = (input: PluginDoctorCheckInput) => Effect.Effect<ReadonlySet<string>>;

export const makeOrphanRouteFilesCheck = (
  listKnownAppIds?: KnownAppIdReader,
): PluginDoctorCheckContribution => ({
  id: "orphan-route-files",
  run: Effect.fnUntraced(function* (input) {
    if (input.userDataRoot === undefined) return [];
    const paths: ProxyPaths = {
      platform: input.platform,
      globalAppRoot: globalAppRootPath(input.userDataRoot, input.platform),
    };
    const names = yield* readRouteFileNames(paths);
    if (names.length === 0) return [];
    const known = yield* listKnownAppIds
      ? listKnownAppIds(input)
      : Effect.promise(() => listKnownAppIdsFromUserData(input.userDataRoot ?? ""));
    const orphans = names.flatMap((name) => {
      const app = routeFileAppId(name);
      if (app === undefined || known.has(String(app))) return [];
      return [String(app)];
    });
    if (orphans.length === 0) return [];
    return [orphanReport([...new Set(orphans)].sort((left, right) => left.localeCompare(right)))];
  }),
});

export const orphanRouteFilesCheck = makeOrphanRouteFilesCheck();
