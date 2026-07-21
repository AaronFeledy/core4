import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { deserialize, serialize } from "node:v8";

import { Effect, Schema } from "effect";

import { CacheError } from "@lando/sdk/errors";
import { AppPlan } from "@lando/sdk/schema";
import { CacheService } from "@lando/sdk/services";

import {
  type VersionConstraintEntry,
  evaluateVersionConstraints,
  isVersionConstraintEntryArray,
  isVersionConstraintSkipped,
} from "../config/version-constraint.ts";
import { presentLandofileLayers } from "../landofile/layers.ts";
import { CORE_VERSION } from "../version.ts";
import { APP_PLAN_CACHE_SCHEMA_VERSION, type AppPlanSourceFingerprint } from "./app-plan-key.ts";
import { appPlanCachePath } from "./paths.ts";

export { APP_PLAN_CACHE_SCHEMA_VERSION, deriveAppPlanCacheKey } from "./app-plan-key.ts";
export type { AppPlanCacheKeyInput, AppPlanSourceFingerprint } from "./app-plan-key.ts";

export const APP_PLAN_CACHE_MAGIC = Buffer.from("LCAP");
export const APP_PLAN_CACHE_HEADER_BYTES = 44;

interface AppPlanCachePayload {
  readonly schemaVersion: number;
  readonly landoVersion: string;
  readonly key: string;
  readonly versionConstraints: ReadonlyArray<VersionConstraintEntry>;
  readonly generatedAtMs: number;
  readonly plan: unknown;
}

const sha256 = (payload: Uint8Array | string): Buffer => createHash("sha256").update(payload).digest();

const sha256Hex = (payload: Uint8Array | string): string => sha256(payload).toString("hex");

const isEnoent = (cause: unknown): boolean =>
  typeof cause === "object" && cause !== null && (cause as { code?: unknown }).code === "ENOENT";

const readOptionalHash = (path: string): Promise<string | null> =>
  readFile(path).then(
    (content) => sha256Hex(content),
    (cause) => {
      if (isEnoent(cause)) return null;
      throw cause;
    },
  );

const INCLUDE_LOCK_CHECKSUM_PATTERN = /^\s*checksum:\s*['"]?([A-Fa-f0-9]{64})['"]?\s*$/gmu;

const readIncludeLockChecksums = (path: string): Promise<ReadonlyArray<string>> =>
  readFile(path, "utf8").then(
    (content) =>
      [...content.matchAll(INCLUDE_LOCK_CHECKSUM_PATTERN)]
        .map((match) => match[1])
        .filter((checksum): checksum is string => checksum !== undefined)
        .map((checksum) => checksum.toLowerCase())
        .sort(),
    (cause) => {
      if (isEnoent(cause)) return [];
      throw cause;
    },
  );

export const readAppPlanSourceFingerprint = (
  appRoot: string,
): Effect.Effect<AppPlanSourceFingerprint, CacheError> =>
  Effect.tryPromise({
    try: async () => {
      const includeLockfilePath = join(appRoot, ".lando.lock.yml");
      const layers = await presentLandofileLayers(appRoot);
      return {
        landofileContentHashes: await Promise.all(
          layers.map(async (layer) => ({
            source: layer.filePath,
            hash: (await readOptionalHash(layer.filePath)) ?? "",
          })),
        ),
        includeLockfileHash: await readOptionalHash(includeLockfilePath),
        includedFragmentShas: await readIncludeLockChecksums(includeLockfilePath),
      };
    },
    catch: (cause) =>
      new CacheError({
        message: `Failed to read app-plan cache source fingerprint for ${appRoot}.`,
        key: "app-plan",
        path: appRoot,
        cause,
      }),
  });

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

const withDerivedRouteRequirements = (plan: AppPlan): AppPlan => {
  if (plan.routes.length === 0) return plan;

  const current = plan.requires?.globalServices ?? [];
  if (current.includes("traefik")) return plan;

  return {
    ...plan,
    requires: {
      ...plan.requires,
      globalServices: [...current, "traefik"],
    },
  };
};

const versionConstraintsUsable = (entries: ReadonlyArray<VersionConstraintEntry>): boolean => {
  const evaluation = evaluateVersionConstraints(entries, CORE_VERSION);
  if (evaluation.invalid.length > 0) return false;
  return evaluation.unsatisfied.length === 0 || isVersionConstraintSkipped(process.env);
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
        (error) => isEnoent(error.cause),
        () => Effect.succeed(null),
      ),
    );
    if (bytes === null) return null;
    const payload = decode(bytes);
    if (payload === null) return null;
    if (payload.landoVersion !== CORE_VERSION || payload.key !== input.key) return null;
    if (!isVersionConstraintEntryArray(payload.versionConstraints)) return null;
    if (!versionConstraintsUsable(payload.versionConstraints)) return null;
    return yield* Effect.try({
      try: () => withDerivedRouteRequirements(Schema.decodeUnknownSync(AppPlan)(payload.plan)),
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
  readonly versionConstraints?: ReadonlyArray<VersionConstraintEntry>;
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
          versionConstraints: input.versionConstraints ?? [],
          generatedAtMs: (input.now ?? Date.now)(),
          plan: Schema.encodeSync(AppPlan)(input.plan),
        }),
      )
      .pipe(Effect.as(path)),
  );
};
