/**
 * Label, discover, and force-remove leftover ephemeral data helpers so volume
 * teardown does not loop on a 409 from a helper left by SIGKILL or a crash.
 */
import { Effect } from "effect";

import { encodeEngineFilters, parseJsonOrUndefined } from "./engine-json.ts";
import { APP_LABEL, EPHEMERAL_DATA_ROLE, PROVIDER_LABEL, ROLE_LABEL, STORE_LABEL } from "./labels.ts";
import { redactString, withApiReason } from "./redact.ts";

export interface HelperHttpRequest {
  readonly method: "GET" | "DELETE";
  readonly path: `/${string}`;
}

export interface HelperHttpResponse {
  readonly status: number;
  readonly body: string;
}

export type HelperRequester = (request: HelperHttpRequest) => Effect.Effect<HelperHttpResponse, unknown>;

export interface VolumeHolder {
  readonly id: string;
  readonly name: string;
  readonly labels: Readonly<Record<string, string>>;
  readonly mountNames: ReadonlyArray<string>;
}

const sanitize = (value: string): string => value.replace(/[^a-zA-Z0-9_.-]/gu, "-");

export const ephemeralDataHelperNamePrefix = (providerId: string): string =>
  `lando-${sanitize(providerId)}-data-`;

export const isEphemeralDataHelperName = (name: string, providerId: string): boolean =>
  containerName(name).startsWith(ephemeralDataHelperNamePrefix(providerId));

export const ephemeralDataHelperLabels = (input: {
  readonly providerId: string;
  readonly app?: string;
  readonly store?: string;
}): Readonly<Record<string, string>> => ({
  [ROLE_LABEL]: EPHEMERAL_DATA_ROLE,
  [PROVIDER_LABEL]: input.providerId,
  ...(input.app === undefined ? {} : { [APP_LABEL]: input.app }),
  ...(input.store === undefined ? {} : { [STORE_LABEL]: input.store }),
});

export const isLabeledEphemeralDataHelper = (
  labels: Readonly<Record<string, string>>,
  input: { readonly appId: string; readonly providerId: string },
): boolean =>
  labels[ROLE_LABEL] === EPHEMERAL_DATA_ROLE &&
  labels[APP_LABEL] === input.appId &&
  labels[PROVIDER_LABEL] === input.providerId;

export const isVolumeInUse = (details: unknown): details is { readonly body: string } => {
  if (typeof details !== "object" || details === null) return false;
  if (!("body" in details) || typeof details.body !== "string") return false;
  return (
    ("status" in details && details.status === 409) || /\b(?:in use|being used by)\b/i.test(details.body)
  );
};

export const volumeInUseRemediation = (holders: ReadonlyArray<string> = []): string => {
  const named =
    holders.length === 0
      ? "A leftover container still uses this volume."
      : holders.length === 1
        ? `Container ${holders[0]} still uses this volume.`
        : `Containers ${holders.join(", ")} still use this volume.`;
  return `${named} Remove that leftover data helper, then retry \`lando destroy --volumes\`. \`lando doctor\` cannot see these helpers.`;
};

export const volumeInUseMessage = (
  base: string,
  holders: ReadonlyArray<string>,
  details?: unknown,
): string => {
  const named = holders.length === 0 ? base : `${base} Held by ${holders.join(", ")}.`;
  const withReason = withApiReason(named, details);
  return withReason === named &&
    details !== undefined &&
    typeof details === "object" &&
    details !== null &&
    "body" in details &&
    typeof details.body === "string" &&
    details.body.trim().length > 0
    ? `${named} ${redactString(details.body.trim())}`
    : withReason;
};

const containerName = (name: string): string => name.replace(/^\//u, "");

const stringRecord = (value: unknown): Readonly<Record<string, string>> => {
  if (typeof value !== "object" || value === null) return {};
  const labels: Record<string, string> = {};
  for (const [key, label] of Object.entries(value)) {
    if (typeof label === "string") labels[key] = label;
  }
  return labels;
};

const listedName = (value: unknown): string | undefined => {
  if (typeof value === "string" && value.length > 0) return containerName(value);
  if (!Array.isArray(value)) return undefined;
  for (const entry of value) {
    if (typeof entry === "string" && entry.length > 0) return containerName(entry);
  }
  return undefined;
};

const parseListedContainers = (body: string): ReadonlyArray<VolumeHolder> => {
  const parsed = parseJsonOrUndefined(body);
  const items = Array.isArray(parsed) ? parsed : undefined;
  if (items === undefined) return [];
  return items.flatMap((item): ReadonlyArray<VolumeHolder> => {
    if (typeof item !== "object" || item === null) return [];
    const id = Reflect.get(item, "Id");
    const name = listedName(Reflect.get(item, "Names")) ?? listedName(Reflect.get(item, "Name"));
    if (typeof id !== "string" || id.length === 0) return [];
    return [
      {
        id,
        name: name ?? id,
        labels: stringRecord(Reflect.get(item, "Labels")),
        mountNames: mountNamesFrom(Reflect.get(item, "Mounts")),
      },
    ];
  });
};

const mountNamesFrom = (value: unknown): ReadonlyArray<string> => {
  if (!Array.isArray(value)) return [];
  return value.flatMap((mount) => {
    if (typeof mount !== "object" || mount === null) return [];
    const names = [Reflect.get(mount, "Name"), Reflect.get(mount, "Source")].filter(
      (entry): entry is string => typeof entry === "string" && entry.length > 0,
    );
    return names;
  });
};

const mountsNamedVolume = (container: unknown, volumeName: string): boolean => {
  const mounts =
    typeof container === "object" && container !== null ? Reflect.get(container, "Mounts") : undefined;
  return mountNamesFrom(mounts).includes(volumeName);
};

const listContainers = (request: HelperRequester, filters: Readonly<Record<string, ReadonlyArray<string>>>) =>
  request({
    method: "GET",
    path: `/containers/json?all=true&filters=${encodeEngineFilters(filters)}`,
  });

const forceRemoveContainer = (request: HelperRequester, id: string) =>
  request({
    method: "DELETE",
    path: `/containers/${encodeURIComponent(id)}?force=true`,
  }).pipe(
    Effect.map((response) => response.status === 404 || (response.status >= 200 && response.status < 300)),
    Effect.catch(() => Effect.succeed(false)),
  );

export const listLabeledEphemeralDataHelpers = (
  request: HelperRequester,
  input: { readonly appId: string; readonly providerId: string },
): Effect.Effect<ReadonlyArray<VolumeHolder>, unknown> =>
  listContainers(request, {
    label: [
      `${ROLE_LABEL}=${EPHEMERAL_DATA_ROLE}`,
      `${APP_LABEL}=${input.appId}`,
      `${PROVIDER_LABEL}=${input.providerId}`,
    ],
  }).pipe(
    Effect.map((response) =>
      response.status >= 200 && response.status < 300
        ? parseListedContainers(response.body).filter((holder) =>
            isLabeledEphemeralDataHelper(holder.labels, input),
          )
        : [],
    ),
  );

export const listVolumeHolders = (
  request: HelperRequester,
  volumeName: string,
): Effect.Effect<ReadonlyArray<VolumeHolder>, unknown> =>
  listContainers(request, { volume: [volumeName] }).pipe(
    Effect.map((response) =>
      response.status >= 200 && response.status < 300 ? parseListedContainers(response.body) : [],
    ),
    Effect.catch(() => Effect.succeed<ReadonlyArray<VolumeHolder>>([])),
  );

const inspectMountsVolume = (request: HelperRequester, holder: VolumeHolder, volumeName: string) =>
  request({
    method: "GET",
    path: `/containers/${encodeURIComponent(holder.id)}/json`,
  }).pipe(
    Effect.map((response) => {
      if (response.status < 200 || response.status >= 300) return false;
      return mountsNamedVolume(parseJsonOrUndefined(response.body), volumeName);
    }),
    Effect.catch(() => Effect.succeed(false)),
  );

export const removeEphemeralDataHelpers = Effect.fnUntraced(function* (
  request: HelperRequester,
  input: { readonly appId: string; readonly providerId: string },
): Effect.fn.Return<ReadonlyArray<string>, unknown> {
  const helpers = yield* listLabeledEphemeralDataHelpers(request, input);
  const removed: string[] = [];
  for (const helper of helpers) {
    if (yield* forceRemoveContainer(request, helper.id)) removed.push(helper.name);
  }
  return removed;
});

export const removeUnlabeledEphemeralDataHolders = Effect.fnUntraced(function* (
  request: HelperRequester,
  input: { readonly providerId: string; readonly volumeName: string },
): Effect.fn.Return<
  { readonly removed: ReadonlyArray<string>; readonly remaining: ReadonlyArray<VolumeHolder> },
  unknown
> {
  const holders = yield* listVolumeHolders(request, input.volumeName);
  const remaining: VolumeHolder[] = [];
  const removed: string[] = [];
  for (const holder of holders) {
    if (!isEphemeralDataHelperName(holder.name, input.providerId)) {
      remaining.push(holder);
      continue;
    }
    const listedMounts =
      holder.mountNames.includes(input.volumeName) ||
      (holder.mountNames.length === 0 && (yield* inspectMountsVolume(request, holder, input.volumeName)));
    if (!listedMounts) {
      remaining.push(holder);
      continue;
    }
    if (yield* forceRemoveContainer(request, holder.id)) removed.push(holder.name);
    else remaining.push(holder);
  }
  return { removed, remaining };
});

export const releaseVolumeHolders = Effect.fnUntraced(function* (
  request: HelperRequester,
  input: { readonly appId: string; readonly providerId: string; readonly volumeName: string },
): Effect.fn.Return<ReadonlyArray<VolumeHolder>, unknown> {
  yield* removeEphemeralDataHelpers(request, input);
  const unlabeled = yield* removeUnlabeledEphemeralDataHolders(request, input);
  return unlabeled.remaining;
});
