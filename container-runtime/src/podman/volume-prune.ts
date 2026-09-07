import { Effect } from "effect";

import { ProviderInternalError, ProviderUnavailableError } from "@lando/sdk/errors";
import type { AppPlan } from "@lando/sdk/schema";

import type { EngineHttpApi, EngineHttpRequest, ProviderErrorContext } from "../engine-api.ts";
import { redactDetails, redactString, withApiReason } from "../redact.ts";

/** Podman libpod filter map: filter key -> list of values, ANDed across entries. */
export type VolumeFilterMap = Readonly<Record<string, ReadonlyArray<string>>>;
export type VolumeSelectorClass = "cache" | "data";

export interface LandoVolumeFilterOptions {
  readonly providerId: string;
  readonly volumeClasses?: ReadonlyArray<VolumeSelectorClass>;
  /** Narrow to a single store scope (e.g. `"app"`) in addition to the app label. */
  readonly scope?: AppPlan["stores"][number]["scope"];
}

export const volumeSelectorValue = (args: {
  readonly providerId: string;
  readonly appId: string;
  readonly volumeClass: VolumeSelectorClass;
  readonly scope?: AppPlan["stores"][number]["scope"];
}): string =>
  args.scope === undefined
    ? `${args.providerId}:${args.appId}:${args.volumeClass}`
    : `${args.providerId}:${args.appId}:${args.volumeClass}:${args.scope}`;

export const volumeSelectorLabel = (value: string): string => `dev.lando.volume-selector=${value}`;

/** Lando-scoped volume filters use ownership-complete selector values because Podman ORs values for one key. */
export const buildLandoVolumeFilters = (
  appId: string,
  options: LandoVolumeFilterOptions,
): VolumeFilterMap => {
  const providerId = options.providerId;
  const volumeClasses = options.volumeClasses ?? (["data"] as const);
  return {
    label: volumeClasses.map((volumeClass) =>
      volumeSelectorLabel(
        volumeSelectorValue({
          providerId,
          appId,
          volumeClass,
          ...(options.scope === undefined ? {} : { scope: options.scope }),
        }),
      ),
    ),
  };
};

const splitLabelCriterion = (criterion: string): { readonly key: string; readonly value?: string } => {
  const eq = criterion.indexOf("=");
  return eq === -1 ? { key: criterion } : { key: criterion.slice(0, eq), value: criterion.slice(eq + 1) };
};

const matchesLabel = (labels: Readonly<Record<string, string>>, criterion: string): boolean => {
  const { key, value } = splitLabelCriterion(criterion);
  if (!(key in labels)) return false;
  return value === undefined ? true : labels[key] === value;
};

/** Pure matcher for `label` / `label!` criteria; ignores non-label filter keys. */
export const volumeMatchesFilters = (
  labels: Readonly<Record<string, string>>,
  filters: VolumeFilterMap,
): boolean => {
  for (const criterion of filters.label ?? []) {
    if (!matchesLabel(labels, criterion)) return false;
  }
  for (const criterion of filters["label!"] ?? []) {
    if (matchesLabel(labels, criterion)) return false;
  }
  return true;
};

export interface VolumePruneOptions {
  /** Required scoped filter set (prevents unscoped prune requests). */
  readonly filters: VolumeFilterMap;
  /** Provider identity and remediation carried into every produced failure. */
  readonly ctx: ProviderErrorContext;
  /** When true, add `all=true` for named unused volumes; default is anonymous-only. */
  readonly all?: boolean;
  /** When true, forward `dryrun=true` for a non-destructive preview. */
  readonly dryRun?: boolean;
}

/** Build `POST /libpod/volumes/prune` with JSON-encoded `filters` and optional `dryrun`. */
export const buildVolumePruneRequest = (options: VolumePruneOptions): EngineHttpRequest => {
  const query = `filters=${encodeURIComponent(JSON.stringify(options.filters))}`;
  const all = options.all === true ? "&all=true" : "";
  const dryRun = options.dryRun === true ? "&dryrun=true" : "";
  return { method: "POST", path: `/libpod/volumes/prune?${query}${all}${dryRun}` };
};

export interface PrunedVolume {
  readonly id: string;
  readonly size?: number;
}

export interface VolumePruneError {
  readonly id: string;
  readonly message: string;
}

export interface VolumePruneParse {
  readonly pruned: ReadonlyArray<PrunedVolume>;
  readonly errors: ReadonlyArray<VolumePruneError>;
  readonly spaceReclaimed: number;
}

export interface VolumePruneReport extends VolumePruneParse {
  /** True when the request was a preview and nothing was actually deleted. */
  readonly dryRun: boolean;
}

const stringOrUndefined = (value: unknown): string | undefined =>
  typeof value === "string" && value.length > 0 ? value : undefined;

const numberOrUndefined = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

const EMPTY: VolumePruneParse = { pruned: [], errors: [], spaceReclaimed: 0 };

const parseLibpodArray = (entries: ReadonlyArray<unknown>): VolumePruneParse => {
  const pruned: PrunedVolume[] = [];
  const errors: VolumePruneError[] = [];
  let spaceReclaimed = 0;
  for (const entry of entries) {
    if (typeof entry !== "object" || entry === null) continue;
    const id = stringOrUndefined(Reflect.get(entry, "Id"));
    if (id === undefined) continue;
    const err = stringOrUndefined(Reflect.get(entry, "Err"));
    if (err !== undefined) {
      errors.push({ id, message: err });
      continue;
    }
    const size = numberOrUndefined(Reflect.get(entry, "Size"));
    if (size !== undefined) spaceReclaimed += size;
    pruned.push(size === undefined ? { id } : { id, size });
  }
  return { pruned, errors, spaceReclaimed };
};

const parseDockerCompat = (record: object): VolumePruneParse => {
  const deletedValue = Reflect.get(record, "VolumesDeleted");
  const deleted = Array.isArray(deletedValue) ? deletedValue : [];
  const pruned: PrunedVolume[] = [];
  for (const value of deleted) {
    const id = stringOrUndefined(value);
    if (id !== undefined) pruned.push({ id });
  }
  return {
    pruned,
    errors: [],
    spaceReclaimed: numberOrUndefined(Reflect.get(record, "SpaceReclaimed")) ?? 0,
  };
};

/**
 * Parse libpod array or Docker-compat prune JSON. Pure (no redaction); failures
 * are redacted in {@link pruneVolumes}.
 */
export const parseVolumePruneResult = (body: string): VolumePruneParse => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return EMPTY;
  }
  if (Array.isArray(parsed)) return parseLibpodArray(parsed);
  if (typeof parsed === "object" && parsed !== null) return parseDockerCompat(parsed);
  return EMPTY;
};

const missingRequest = (ctx: ProviderErrorContext): ProviderInternalError =>
  new ProviderInternalError({
    providerId: ctx.providerId,
    operation: "pruneVolumes",
    message: "The Podman API client does not support requests required for volume prune.",
    remediation: ctx.remediation,
  });

const pruneFailure = (ctx: ProviderErrorContext, status: number, body: string): ProviderUnavailableError =>
  new ProviderUnavailableError({
    providerId: ctx.providerId,
    operation: "pruneVolumes",
    message: redactString(withApiReason(`Podman volume prune failed with HTTP ${status}.`, { body })),
    details: redactDetails({ status, body }),
    remediation: ctx.remediation,
  });

/** Call libpod volume prune; maps non-2xx to a redacted {@link ProviderUnavailableError}. */
export const pruneVolumes = (
  api: EngineHttpApi,
  options: VolumePruneOptions,
): Effect.Effect<VolumePruneReport, ProviderUnavailableError | ProviderInternalError> =>
  Effect.gen(function* () {
    const requestFn = api.request;
    if (requestFn === undefined) return yield* Effect.fail(missingRequest(options.ctx));
    const response = yield* requestFn(buildVolumePruneRequest(options));
    if (response.status < 200 || response.status >= 300) {
      return yield* Effect.fail(pruneFailure(options.ctx, response.status, response.body));
    }
    return { ...parseVolumePruneResult(response.body), dryRun: options.dryRun === true };
  });
