import { readFile, readdir } from "node:fs/promises";
import { basename, join } from "node:path";

import { Effect, Schema } from "effect";

import type { ConfigError, LandoCommandError } from "@lando/sdk/errors";
import { ConfigService } from "@lando/sdk/services";

import { listCwdAppMapEntries } from "../../cache/cwd-app-map.ts";
import { resolveUserCacheRoot } from "../../cache/paths.ts";

export interface AppsListEntry {
  readonly appId: string;
  readonly appName: string;
  readonly providerId: string;
  readonly appRoot: string;
  readonly services: ReadonlyArray<string>;
}

export const AppsListEntrySchema = Schema.Struct({
  appId: Schema.String,
  appName: Schema.String,
  providerId: Schema.String,
  appRoot: Schema.String,
  services: Schema.Array(Schema.String),
});

export const AppsListResultSchema = Schema.Struct({
  apps: Schema.Array(AppsListEntrySchema),
});

export interface ListServicesOptions {
  readonly path?: string;
  readonly format?: "json" | "table";
  readonly userDataRoot?: string;
  readonly userCacheRoot?: string;
}

export interface ListServicesResult {
  readonly apps: ReadonlyArray<AppsListEntry>;
}

interface AppliedPlanEnvelope {
  readonly version: number;
  readonly providerId?: string;
  readonly plan?: unknown;
}

const PROVIDER_DIRS = ["provider-lando", "provider-docker"] as const;

interface DiscoveredPlan {
  readonly id: string;
  readonly name?: string;
  readonly root: string;
  readonly services: ReadonlyArray<string>;
}

const decodeEnvelopeFile = (content: string): DiscoveredPlan | undefined => {
  let envelope: AppliedPlanEnvelope;
  try {
    envelope = JSON.parse(content) as AppliedPlanEnvelope;
  } catch {
    return undefined;
  }
  const plan = envelope.plan as
    | { id?: unknown; name?: unknown; root?: unknown; services?: unknown }
    | undefined;
  if (
    plan === undefined ||
    typeof plan.id !== "string" ||
    typeof plan.root !== "string" ||
    plan.services === null ||
    typeof plan.services !== "object"
  ) {
    return undefined;
  }
  const services = Object.keys(plan.services as Record<string, unknown>);
  return {
    id: plan.id,
    ...(typeof plan.name === "string" ? { name: plan.name } : {}),
    root: plan.root,
    services,
  };
};

const readAppsFromProvider = async (
  providerDir: string,
  providerId: string,
): Promise<ReadonlyArray<AppsListEntry>> => {
  let entries: ReadonlyArray<string>;
  try {
    entries = await readdir(providerDir);
  } catch {
    return [];
  }
  const apps: AppsListEntry[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(".json")) continue;
    try {
      const content = await readFile(join(providerDir, entry), "utf8");
      const plan = decodeEnvelopeFile(content);
      if (plan === undefined) continue;
      apps.push({
        appId: plan.id,
        appName: plan.name ?? plan.id,
        providerId,
        appRoot: plan.root,
        services: plan.services,
      });
    } catch {
      // ignore unreadable / corrupt state files
    }
  }
  return apps;
};

const cacheEntryToApp = (entry: { readonly appRoot: string }): AppsListEntry => ({
  appId: basename(entry.appRoot) || entry.appRoot,
  appName: basename(entry.appRoot) || entry.appRoot,
  providerId: "cache",
  appRoot: entry.appRoot,
  services: [],
});

export const renderAppsListResult = (
  result: ListServicesResult,
  _format: "json" | "table" = "table",
): string => {
  if (result.apps.length === 0) {
    return "No Lando apps applied on this host.";
  }
  const header = ["APP", "PROVIDER", "SERVICES", "ROOT"];
  const rows = result.apps.map((app) => [
    app.appName,
    app.providerId,
    app.services.join(",") || "-",
    app.appRoot,
  ]);
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? "").length)));
  const pad = (cells: ReadonlyArray<string>): string =>
    cells.map((c, i) => (i === cells.length - 1 ? c : c.padEnd(widths[i] ?? 0))).join("  ");
  return [pad(header), ...rows.map(pad)].join("\n");
};

export const listServices = (
  options: ListServicesOptions = {},
): Effect.Effect<ListServicesResult, ConfigError | LandoCommandError, ConfigService> =>
  Effect.gen(function* () {
    const configService = yield* ConfigService;
    const userDataRoot = options.userDataRoot ?? (yield* configService.get("userDataRoot"));
    if (userDataRoot === undefined) return { apps: [] };

    const providersRoot = join(userDataRoot, "providers");
    const apps: AppsListEntry[] = [];
    for (const providerName of PROVIDER_DIRS) {
      const providerDir = join(providersRoot, providerName, "apps");
      const providerApps = yield* Effect.promise(() =>
        readAppsFromProvider(providerDir, providerName.replace(/^provider-/, "")),
      );
      apps.push(...providerApps);
    }

    const userCacheRoot = options.userCacheRoot ?? resolveUserCacheRoot();
    const cachedApps = yield* listCwdAppMapEntries(userCacheRoot).pipe(
      Effect.catchAll(() => Effect.succeed([])),
    );
    for (const cached of cachedApps) {
      if (!apps.some((app) => app.appRoot === cached.appRoot)) {
        apps.push(cacheEntryToApp(cached));
      }
    }

    const pathFilter = options.path;
    const filtered = pathFilter === undefined ? apps : apps.filter((a) => a.appRoot.includes(pathFilter));
    filtered.sort((a, b) => a.appName.localeCompare(b.appName));
    return { apps: filtered };
  });
