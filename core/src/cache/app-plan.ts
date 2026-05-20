import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { deserialize, serialize } from "node:v8";

import { Effect, Schema } from "effect";

import { CacheError } from "@lando/sdk/errors";
import {
  AppPlan,
  type LandofileShape,
  type PluginManifest,
  type ProviderCapabilities,
} from "@lando/sdk/schema";
import { CacheService } from "@lando/sdk/services";

import { CORE_VERSION } from "../version.ts";
import { appPlanCachePath } from "./paths.ts";

export const APP_PLAN_CACHE_MAGIC = Buffer.from("LCAP");
export const APP_PLAN_CACHE_HEADER_BYTES = 44;
export const APP_PLAN_CACHE_SCHEMA_VERSION = 1n;

interface AppPlanCachePayload {
  readonly schemaVersion: number;
  readonly landoVersion: string;
  readonly key: string;
  readonly generatedAtMs: number;
  readonly plan: unknown;
}

export interface AppPlanCacheKeyInput {
  readonly appRoot: string;
  readonly landofile: LandofileShape;
  readonly providerCapabilities: ProviderCapabilities;
  readonly pluginManifests: ReadonlyArray<PluginManifest>;
  readonly config?: unknown;
  readonly serviceInputs?: unknown;
}

const sha256 = (payload: Uint8Array | string): Buffer => createHash("sha256").update(payload).digest();

const stable = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(stable);
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "bigint") return value.toString();
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, child]) => [key, stable(child)]),
    );
  }
  return value;
};

const stableStringify = (value: unknown): string => JSON.stringify(stable(value));

const normalizeManifest = (manifest: PluginManifest) => ({
  name: manifest.name,
  version: manifest.version,
  api: manifest.api,
  enabled: manifest.enabled ?? true,
  bundled: manifest.bundled ?? false,
  contributes: manifest.contributes ?? {},
});

export const deriveAppPlanCacheKey = (input: AppPlanCacheKeyInput): string => {
  // Keep registry list order out of the cache key for equivalent manifests.
  const sortedManifests = input.pluginManifests
    .map(normalizeManifest)
    .sort((a, b) =>
      a.name === b.name
        ? a.version === b.version
          ? a.api - b.api
          : a.version.localeCompare(b.version)
        : a.name.localeCompare(b.name),
    );
  return sha256(
    stableStringify({
      cache: "app-plan",
      schemaVersion: Number(APP_PLAN_CACHE_SCHEMA_VERSION),
      landoVersion: CORE_VERSION,
      appRoot: input.appRoot,
      landofile: input.landofile,
      providerCapabilities: input.providerCapabilities,
      pluginManifests: sortedManifests,
      config: input.config ?? null,
      serviceInputs: input.serviceInputs ?? input.landofile.services ?? {},
    }),
  ).toString("hex");
};

const encode = (payload: AppPlanCachePayload): Uint8Array => {
  const body = serialize(payload);
  const header = Buffer.alloc(APP_PLAN_CACHE_HEADER_BYTES);
  APP_PLAN_CACHE_MAGIC.copy(header, 0);
  header.writeBigUInt64BE(APP_PLAN_CACHE_SCHEMA_VERSION, 4);
  sha256(body).copy(header, 12);
  return Buffer.concat([header, body]);
};

const decode = (bytes: Uint8Array): AppPlanCachePayload | null => {
  try {
    const buffer = Buffer.from(bytes);
    if (buffer.length <= APP_PLAN_CACHE_HEADER_BYTES) return null;
    if (!buffer.subarray(0, 4).equals(APP_PLAN_CACHE_MAGIC)) return null;
    if (buffer.readBigUInt64BE(4) !== APP_PLAN_CACHE_SCHEMA_VERSION) return null;
    const body = buffer.subarray(APP_PLAN_CACHE_HEADER_BYTES);
    if (!sha256(body).equals(buffer.subarray(12, APP_PLAN_CACHE_HEADER_BYTES))) return null;
    const payload = deserialize(body) as AppPlanCachePayload;
    if (payload.schemaVersion !== Number(APP_PLAN_CACHE_SCHEMA_VERSION)) return null;
    return payload;
  } catch {
    return null;
  }
};

export const readCachedAppPlan = (input: {
  readonly cacheRoot: string;
  readonly appName: string;
  readonly appRoot: string;
  readonly key: string;
}): Effect.Effect<AppPlan | null, CacheError> =>
  Effect.gen(function* () {
    const path = appPlanCachePath(input.cacheRoot, input.appName, input.appRoot);
    const bytes = yield* Effect.tryPromise({
      try: () => readFile(path),
      catch: (cause) =>
        new CacheError({
          message: `Failed to read app-plan cache at ${path}.`,
          key: "app-plan",
          path,
          cause,
        }),
    }).pipe(
      Effect.catchIf(
        (error) =>
          typeof error.cause === "object" &&
          error.cause !== null &&
          (error.cause as { code?: unknown }).code === "ENOENT",
        () => Effect.succeed(null),
      ),
    );
    if (bytes === null) return null;
    const payload = decode(bytes);
    if (payload === null) return null;
    if (payload.landoVersion !== CORE_VERSION || payload.key !== input.key) return null;
    return yield* Effect.try({
      try: () => Schema.decodeUnknownSync(AppPlan)(payload.plan),
      catch: (cause) =>
        new CacheError({
          message: `Cached app plan at ${path} failed schema decode.`,
          key: "app-plan",
          path,
          decodeError: cause,
        }),
    }).pipe(Effect.catchAll(() => Effect.succeed(null)));
  });

export const writeCachedAppPlan = (input: {
  readonly cacheRoot: string;
  readonly appName: string;
  readonly appRoot: string;
  readonly key: string;
  readonly plan: AppPlan;
  readonly now?: () => number;
}): Effect.Effect<string, CacheError, CacheService> => {
  const path = appPlanCachePath(input.cacheRoot, input.appName, input.appRoot);
  return Effect.flatMap(CacheService, (cache) =>
    cache
      .writeAtomic(
        path,
        encode({
          schemaVersion: Number(APP_PLAN_CACHE_SCHEMA_VERSION),
          landoVersion: CORE_VERSION,
          key: input.key,
          generatedAtMs: (input.now ?? Date.now)(),
          plan: Schema.encodeSync(AppPlan)(input.plan),
        }),
      )
      .pipe(Effect.as(path)),
  );
};
