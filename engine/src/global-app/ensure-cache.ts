import { readFile, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";

import { presentLandofileLayers } from "@lando/landofile/layers";
import { getLandofileReferencedFiles } from "@lando/landofile/load-expression-provenance";
import { getSourceDocuments } from "@lando/landofile/pipeline/source-table";
import { readGlobalConfigSources } from "@lando/paths/config-sources";
import { canonicalJson, sha256Hex } from "@lando/sdk/digest";
import { GlobalAppError } from "@lando/sdk/errors";
import { isPlainRecord } from "@lando/sdk/landofile";
import type { AppPlan, LoadScopedLandofile, ServiceName } from "@lando/sdk/schema";
import {
  ConfigService,
  PathsService,
  PluginRegistry,
  type RuntimeProviderRegistry,
  type RuntimeProviderShape,
  type ServiceRuntimeInfo,
} from "@lando/sdk/services";
import { DateTime, Effect, Option } from "effect";

import { bundledPluginModules } from "../composition.ts";
import { APP_LOCK_HOLDERS_ENV } from "../operations/app-mutation-lock.ts";
import { GlobalPluginManifests } from "../plugins/global-manifests.ts";
import { GlobalConfigSources } from "../services/config.ts";
import { readGlobalResolution } from "./resolution.ts";

export interface GlobalEnsureInputs {
  readonly digest: string;
}

export interface GlobalEnsureRecord {
  readonly plan: AppPlan;
  readonly landofile: LoadScopedLandofile;
  readonly inputs: GlobalEnsureInputs;
  readonly identities: ReadonlyMap<string, string>;
}

// Records cannot cross a retained provider registry or process boundary. Each registry
// retains at most four roots; every reuse still verifies sources and actual containers.
const records = new WeakMap<RuntimeProviderRegistry["Service"], Map<string, GlobalEnsureRecord>>();

export const globalEnsureRecord = (registry: RuntimeProviderRegistry["Service"], root: string) =>
  records.get(registry)?.get(root);

export const forgetGlobalEnsure = (registry: RuntimeProviderRegistry["Service"], root: string): void => {
  records.get(registry)?.delete(root);
};

const cacheableServices = (landofile: LoadScopedLandofile, plan: AppPlan): boolean => {
  if (landofile.document.recipe !== undefined) return false;
  for (const service of Object.values(landofile.document.services ?? {})) {
    // Local build contexts, service-type project inputs, config files and deferred
    // credentials need their normal preparation path; no optimistic cache shortcut.
    if (!["compose", "mailpit", "lando"].includes(String(service.type))) return false;
    if (Object.hasOwn(service, "env_file") || service.config !== undefined) return false;
    if (service.build !== undefined && ("context" in service.build || service.build.app !== undefined))
      return false;
  }
  return Object.values(plan.services).every(
    (service) =>
      Object.values(service.environment).every((value) => typeof value === "string") &&
      !Object.hasOwn(service.environment, APP_LOCK_HOLDERS_ENV),
  );
};

const readSource = async (file: string, expected?: string) => {
  if (!isAbsolute(file)) return undefined;
  const [bytes, target] = await Promise.all([readFile(file), realpath(file)]);
  const digest = sha256Hex(bytes);
  return expected !== undefined && digest !== expected ? undefined : { file, target, digest };
};

/** Fail closed to the normal path when complete declarative source provenance is unavailable. */
export const captureGlobalEnsureInputs = Effect.fnUntraced(
  function* (plan: AppPlan, landofile: LoadScopedLandofile, provider: RuntimeProviderShape) {
    if (!cacheableServices(landofile, plan)) return undefined;
    const documents = getSourceDocuments(landofile.document);
    if (
      documents.length === 0 ||
      documents.some(
        (source) =>
          source.form !== "yaml" ||
          !isAbsolute(source.file) ||
          /\b(?:env|env_file|envFile)\b|\b(?:load|import)\s*\(/u.test(source.content),
      )
    )
      return undefined;
    const paths = yield* PathsService;
    const registry = yield* PluginRegistry;
    const globalCatalog = yield* Effect.serviceOption(GlobalPluginManifests);
    const manifests = yield* registry.list;
    const globalManifests = Option.isSome(globalCatalog) ? yield* globalCatalog.value.list : manifests;
    const resolution = yield* readGlobalResolution({
      providerId: provider.id,
      providerCapabilities: provider.capabilities,
    });
    if (resolution.errors.length > 0) return undefined;
    const bundled = bundledPluginModules();
    if (
      manifests.some(
        (manifest) =>
          !bundled.some((plugin) => plugin.name === manifest.name) &&
          ((manifest.contributes?.serviceTypes?.length ?? 0) > 0 ||
            (manifest.contributes?.serviceFeatures?.length ?? 0) > 0 ||
            (manifest.contributes?.appFeatures?.length ?? 0) > 0),
      )
    )
      return undefined;
    if (
      resolution.entries.some(
        (entry) =>
          entry.state === "enabled" &&
          !bundled.some((plugin) => plugin.name === entry.plugin && plugin.globalServices?.has(entry.id)),
      )
    )
      return undefined;
    const config = yield* Effect.serviceOption(ConfigService);
    const settings = Option.isSome(config) ? yield* config.value.load : undefined;
    const configSources = yield* Effect.serviceOption(GlobalConfigSources);
    const currentConfigSources = Option.isSome(configSources)
      ? yield* Effect.try({ try: () => readGlobalConfigSources(configSources.value), catch: () => undefined })
      : undefined;
    const layers = yield* presentLandofileLayers(plan.root);
    const sources = yield* Effect.tryPromise({
      try: async () => {
        const loaded = await Promise.all(documents.map((source) => readSource(source.file, source.digest)));
        const referenced = await Promise.all(
          getLandofileReferencedFiles(landofile.document).map((source) =>
            readSource(source.absolutePath, source.sha256),
          ),
        );
        if (
          loaded.some((source) => source === undefined) ||
          referenced.some((source) => source === undefined)
        )
          return undefined;
        // Compare canonical paths: the global root itself may be a symlink.
        for (const layer of layers) {
          const target = await realpath(layer.filePath);
          if (!loaded.some((source) => source?.target === target)) return undefined;
        }
        // Include provenance stores canonical targets. Also verify each authored
        // path so retargeting a symlink cannot leave its former target looking fresh.
        const includePaths = [];
        for (const source of documents) {
          if (!isPlainRecord(source.document)) return undefined;
          for (const key of ["includes", "include"]) {
            const entries = source.document[key];
            if (entries === undefined) continue;
            if (!Array.isArray(entries)) return undefined;
            for (const entry of entries) {
              if (isPlainRecord(entry) && entry.optional === true) return undefined;
              const authored =
                typeof entry === "string"
                  ? entry
                  : isPlainRecord(entry)
                    ? (entry.source ?? entry.path)
                    : undefined;
              if (typeof authored !== "string") return undefined;
              const candidate = authored.startsWith("user:")
                ? resolve(paths.userIncludesDir, authored.slice("user:".length))
                : /^[A-Za-z][A-Za-z0-9+.-]*:/u.test(authored)
                  ? undefined
                  : resolve(dirname(source.file), authored);
              if (candidate === undefined) return undefined;
              const current = await readSource(candidate);
              if (
                current === undefined ||
                !loaded.some(
                  (loaded) => loaded?.target === current.target && loaded.digest === current.digest,
                )
              )
                return undefined;
              includePaths.push(current);
            }
          }
        }
        let lock: string | null;
        try {
          lock = sha256Hex(await readFile(join(plan.root, ".lando.lock.yml")));
        } catch (cause) {
          if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
          lock = null;
        }
        return { loaded, referenced, includePaths, lock };
      },
      catch: () => undefined,
    }).pipe(Effect.catch(() => Effect.succeed(undefined)));
    if (sources === undefined) return undefined;
    const environment = Object.fromEntries(
      Object.entries(process.env).filter(([name]) => name !== APP_LOCK_HOLDERS_ENV),
    );
    return {
      digest: sha256Hex(
        canonicalJson({
          root: plan.root,
          roots: paths.roots,
          platform: paths.platform,
          provider: {
            id: provider.id,
            version: provider.version,
            platform: provider.platform,
            capabilities: provider.capabilities,
          },
          manifests,
          globalManifests,
          policy: resolution.policy,
          services: resolution.services,
          entries: resolution.entries,
          settings,
          currentConfigSources,
          environment,
          layers,
          sources,
        }),
      ),
    } satisfies GlobalEnsureInputs;
  },
  Effect.catch(() => Effect.succeed(undefined)),
);

const runtimeIdentity = (runtime: ServiceRuntimeInfo): string | undefined => {
  if (runtime.containerId === undefined || runtime.lastStartedAt === undefined) return undefined;
  const startedAt = DateTime.make(runtime.lastStartedAt);
  return Option.isSome(startedAt)
    ? `${runtime.containerId}:${DateTime.toEpochMillis(startedAt.value)}`
    : undefined;
};

/** Require fresh provider-owned inventory as well as inspect; inspect may synthesize its root from a plan. */
export const observeWarmGlobalServices = Effect.fnUntraced(
  function* (
    record: GlobalEnsureRecord,
    provider: RuntimeProviderShape,
    services: ReadonlyArray<ServiceName>,
  ) {
    const inventory = yield* provider.list({ app: record.plan.id, includeUnplanned: true });
    const observed = new Map<string, ServiceRuntimeInfo>();
    for (const service of services) {
      const expected = record.identities.get(service);
      if (expected === undefined) return undefined;
      const owner = inventory.find(
        (row) =>
          row.app === record.plan.id &&
          row.appRoot === record.plan.root &&
          row.providerId === record.plan.provider &&
          row.service === service &&
          row.containerId === expected.slice(0, expected.lastIndexOf(":")),
      );
      if (owner === undefined || owner.status !== "running") return undefined;
      const runtime = yield* provider.inspect({ app: record.plan.id, service, plan: record.plan });
      if (
        runtimeIdentity(runtime) !== expected ||
        runtime.status !== "running" ||
        (runtime.state !== undefined && runtime.state !== "running") ||
        runtime.health === "unhealthy" ||
        runtime.health === "starting"
      )
        return undefined;
      observed.set(service, runtime);
    }
    return observed;
  },
  Effect.catch(() => Effect.succeed(undefined)),
);

export const rememberGlobalEnsure = (
  registry: RuntimeProviderRegistry["Service"],
  plan: AppPlan,
  landofile: LoadScopedLandofile,
  inputs: GlobalEnsureInputs,
  rows: readonly { readonly name: string; readonly state: string; readonly runtime: ServiceRuntimeInfo }[],
): void => {
  const identities = new Map<string, string>();
  for (const row of rows) {
    const identity = runtimeIdentity(row.runtime);
    if (identity === undefined || !["running", "ready", "healthy"].includes(row.state)) return;
    identities.set(row.name, identity);
  }
  const roots = records.get(registry) ?? new Map<string, GlobalEnsureRecord>();
  roots.delete(plan.root);
  roots.set(plan.root, { plan, landofile, inputs, identities });
  while (roots.size > 4) {
    const oldest = roots.keys().next().value;
    if (oldest !== undefined) roots.delete(oldest);
  }
  records.set(registry, roots);
};

export const globalEnsureChanged = () =>
  new GlobalAppError({
    operation: "ensureRunning",
    message: "Global service configuration changed while verifying a warm start.",
    remediation:
      "Repeat the command to resolve the current policy and configuration before starting services.",
  });
