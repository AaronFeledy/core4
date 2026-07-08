import { Effect } from "effect";

import { ProviderInternalError, ProviderUnavailableError } from "@lando/sdk/errors";
import type { AppPlan } from "@lando/sdk/schema";

import type { PodmanApiClient, PodmanHttpRequest } from "./capabilities.ts";
import { redactDetails, redactString, withApiReason } from "./redact.ts";

const PROVIDER_ID = "lando";

const PRUNE_REMEDIATION =
  "Run `lando doctor` to inspect the Lando runtime, then retry. Run `lando setup` if the runtime is not installed or healthy.";

/** Podman libpod filter map: filter key -> list of values, ANDed across entries. */
export type VolumeFilterMap = Readonly<Record<string, ReadonlyArray<string>>>;

export interface LandoVolumeFilterOptions {
  /** Narrow to a single store scope (e.g. `"app"`) in addition to the app label. */
  readonly scope?: AppPlan["stores"][number]["scope"];
  /** Exclude cache-kind stores via a `label!` negation so caches survive prune. */
  readonly excludeCaches?: boolean;
}

/**
 * Build the Lando-scoped Podman 6 volume filter set. The mandatory
 * `label=dev.lando.app=<appId>` entry means the filter can only ever select
 * volumes this app owns; foreign apps, global stores, and unlabeled volumes
 * are structurally excluded by Podman 6's AND label semantics.
 */
export const buildLandoVolumeFilters = (
  appId: string,
  options: LandoVolumeFilterOptions = {},
): VolumeFilterMap => {
  const label = [`dev.lando.app=${appId}`];
  if (options.scope !== undefined) label.push(`dev.lando.scope=${options.scope}`);
  return {
    label,
    ...(options.excludeCaches === true ? { "label!": ["dev.lando.storage-kind=cache"] } : {}),
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

/**
 * Pure Podman 6 filter matcher for `label` / `label!`. `label` criteria are
 * ANDed (every one must match); `label!` criteria are ANDed too, rejecting the
 * volume if it matches any negated criterion. Non-label keys (`all`,
 * `anonymous`, `until`) govern anonymous scope, not label selection, so they
 * are ignored here. This proves a selected filter set cannot delete volumes
 * outside the current app/provider labels.
 */
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
  /**
   * Required Lando-scoped filter set. Making this mandatory prevents building a
   * Podman 5-style unscoped broad prune by accident.
   */
  readonly filters: VolumeFilterMap;
  /**
   * Opt into removing named unused volumes (`all=true`). Omitted keeps Podman
   * 6's anonymous-only default so named volumes are never removed implicitly.
   */
  readonly all?: boolean;
  /** Preview the prune (`dryrun=true`) without deleting anything. */
  readonly dryRun?: boolean;
}

/**
 * Build the Podman 6 libpod volume-prune request. Anonymous-only is the default
 * (no `all` key); `all=true` is added only when explicitly requested, and
 * `dryrun=true` is forwarded for a non-destructive preview.
 */
export const buildVolumePruneRequest = (options: VolumePruneOptions): PodmanHttpRequest => {
  const filters: Record<string, ReadonlyArray<string>> = { ...options.filters };
  if (options.all === true) filters.all = ["true"];
  const query = `filters=${encodeURIComponent(JSON.stringify(filters))}`;
  const dryRun = options.dryRun === true ? "&dryrun=true" : "";
  return { method: "POST", path: `/libpod/volumes/prune?${query}${dryRun}` };
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
    const record = entry as Record<string, unknown>;
    const id = stringOrUndefined(record.Id);
    if (id === undefined) continue;
    const err = stringOrUndefined(record.Err);
    if (err !== undefined) {
      errors.push({ id, message: err });
      continue;
    }
    const size = numberOrUndefined(record.Size);
    if (size !== undefined) spaceReclaimed += size;
    pruned.push(size === undefined ? { id } : { id, size });
  }
  return { pruned, errors, spaceReclaimed };
};

const parseDockerCompat = (record: Record<string, unknown>): VolumePruneParse => {
  const deleted = Array.isArray(record.VolumesDeleted) ? record.VolumesDeleted : [];
  const pruned: PrunedVolume[] = [];
  for (const value of deleted) {
    const id = stringOrUndefined(value);
    if (id !== undefined) pruned.push({ id });
  }
  return { pruned, errors: [], spaceReclaimed: numberOrUndefined(record.SpaceReclaimed) ?? 0 };
};

/**
 * Parse a Podman 6 volume-prune response. Accepts the libpod array of
 * `{Id, Err?, Size?}` reports and the Docker-compat `{VolumesDeleted,
 * SpaceReclaimed}` shape, returning an empty report for malformed output. This
 * is pure and never redacts; redaction happens at the error boundary in
 * {@link pruneVolumes} so extraction stays unit-testable.
 */
export const parseVolumePruneResult = (body: string): VolumePruneParse => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return EMPTY;
  }
  if (Array.isArray(parsed)) return parseLibpodArray(parsed);
  if (typeof parsed === "object" && parsed !== null) {
    return parseDockerCompat(parsed as Record<string, unknown>);
  }
  return EMPTY;
};

const missingRequest = (): ProviderInternalError =>
  new ProviderInternalError({
    providerId: PROVIDER_ID,
    operation: "pruneVolumes",
    message: "The Podman API client does not support requests required for volume prune.",
    remediation: PRUNE_REMEDIATION,
  });

const pruneFailure = (status: number, body: string): ProviderUnavailableError =>
  new ProviderUnavailableError({
    providerId: PROVIDER_ID,
    operation: "pruneVolumes",
    message: redactString(withApiReason(`Podman volume prune failed with HTTP ${status}.`, { body })),
    details: redactDetails({ status, body }),
    remediation: PRUNE_REMEDIATION,
  });

/**
 * Prune volumes through the Podman 6 libpod endpoint. Honors anonymous-only
 * default vs explicit `all`, previews under `dryRun`, and maps non-2xx
 * responses to a redacted {@link ProviderUnavailableError}. Returns a structured
 * report; this module never writes to console or the process std streams.
 */
export const pruneVolumes = (
  api: PodmanApiClient,
  options: VolumePruneOptions,
): Effect.Effect<VolumePruneReport, ProviderUnavailableError | ProviderInternalError> =>
  Effect.gen(function* () {
    const requestFn = api.request;
    if (requestFn === undefined) return yield* Effect.fail(missingRequest());
    const response = yield* requestFn(buildVolumePruneRequest(options));
    if (response.status < 200 || response.status >= 300) {
      return yield* Effect.fail(pruneFailure(response.status, response.body));
    }
    return { ...parseVolumePruneResult(response.body), dryRun: options.dryRun === true };
  });
