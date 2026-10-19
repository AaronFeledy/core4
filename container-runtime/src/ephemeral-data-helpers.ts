/**
 * Label, discover, and remove leftover data helpers so volume teardown does not
 * loop on a 409 from a helper left by SIGKILL or a crash.
 */
import { Effect } from "effect";

import { encodeEngineFilters, parseJsonOrUndefined } from "./engine-json.ts";
import { APP_LABEL, DATA_HELPER_ROLE, PROVIDER_LABEL, ROLE_LABEL, STORE_LABEL } from "./labels.ts";
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

export type VolumeHolderKind = "data-helper" | "container";

export interface VolumeHolder {
  readonly id: string;
  readonly name: string;
  readonly state: string;
  readonly labels: Readonly<Record<string, string>>;
  readonly mountNames: ReadonlyArray<string>;
}

export interface NamedVolumeHolder {
  readonly name: string;
  readonly kind: VolumeHolderKind;
}

const REMOVABLE_HELPER_STATES = new Set(["exited", "created", "dead"]);

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
  [ROLE_LABEL]: DATA_HELPER_ROLE,
  [PROVIDER_LABEL]: input.providerId,
  ...(input.app === undefined ? {} : { [APP_LABEL]: input.app }),
  ...(input.store === undefined ? {} : { [STORE_LABEL]: input.store }),
});

export const isLabeledEphemeralDataHelper = (
  labels: Readonly<Record<string, string>>,
  input: { readonly appId: string; readonly providerId: string; readonly stores?: ReadonlyArray<string> },
): boolean =>
  labels[ROLE_LABEL] === DATA_HELPER_ROLE &&
  labels[APP_LABEL] === input.appId &&
  labels[PROVIDER_LABEL] === input.providerId &&
  (input.stores === undefined ||
    labels[STORE_LABEL] === undefined ||
    input.stores.includes(labels[STORE_LABEL]));

export const isRemovableHelperState = (state: string): boolean => REMOVABLE_HELPER_STATES.has(state);

export const classifyVolumeHolder = (holder: VolumeHolder, providerId: string): VolumeHolderKind =>
  holder.labels[ROLE_LABEL] === DATA_HELPER_ROLE || isEphemeralDataHelperName(holder.name, providerId)
    ? "data-helper"
    : "container";

export const isVolumeInUse = (details: unknown): details is { readonly body: string } => {
  if (typeof details !== "object" || details === null) return false;
  if (!("body" in details) || typeof details.body !== "string") return false;
  return (
    ("status" in details && details.status === 409) || /\b(?:in use|being used by)\b/i.test(details.body)
  );
};

const holderPhrase = (holders: ReadonlyArray<NamedVolumeHolder>): string => {
  if (holders.length === 0) return "A container still uses this volume.";
  if (holders.length === 1) return `Container ${holders[0]?.name} still uses this volume.`;
  return `Containers ${holders.map((holder) => holder.name).join(", ")} still use this volume.`;
};

const holderAction = (holders: ReadonlyArray<NamedVolumeHolder>): string => {
  if (holders.length === 0) return "Remove it";
  const helpers = holders.every((holder) => holder.kind === "data-helper");
  const containers = holders.every((holder) => holder.kind === "container");
  if (helpers) {
    return holders.length === 1 ? "Remove that leftover data helper" : "Remove those leftover data helpers";
  }
  if (containers) {
    return holders.length === 1 ? "Stop or remove that container" : "Stop or remove those containers";
  }
  return "Stop or remove those containers";
};

export const volumeInUseRemediation = (holders: ReadonlyArray<NamedVolumeHolder> = []): string =>
  `${holderPhrase(holders)} ${holderAction(holders)}, then retry \`lando destroy --volumes\`.`;

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

const listedState = (value: unknown): string => {
  if (typeof value === "string") return value.toLowerCase();
  if (typeof value !== "object" || value === null) return "";
  const status = Reflect.get(value, "Status");
  if (typeof status === "string") return status.toLowerCase();
  const state = Reflect.get(value, "State");
  if (typeof state === "string") return state.toLowerCase();
  return "";
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
        state: listedState(Reflect.get(item, "State")) || listedState(Reflect.get(item, "Status")),
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

const skipCleanupLog = (details: Readonly<Record<string, unknown>>) =>
  Effect.logDebug("Skipped leftover data-helper cleanup after a container list error.").pipe(
    Effect.annotateLogs(details),
  );

const listContainers = (request: HelperRequester, filters: Readonly<Record<string, ReadonlyArray<string>>>) =>
  request({
    method: "GET",
    path: `/containers/json?all=true&filters=${encodeEngineFilters(filters)}`,
  }).pipe(
    Effect.flatMap((response) =>
      response.status >= 200 && response.status < 300
        ? Effect.succeed(parseListedContainers(response.body))
        : skipCleanupLog({ status: response.status }).pipe(Effect.as<ReadonlyArray<VolumeHolder>>([])),
    ),
    Effect.catch((cause) =>
      skipCleanupLog({ cause: String(cause) }).pipe(Effect.as<ReadonlyArray<VolumeHolder>>([])),
    ),
  );

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
  input: { readonly appId: string; readonly providerId: string; readonly stores?: ReadonlyArray<string> },
): Effect.Effect<ReadonlyArray<VolumeHolder>, never> =>
  listContainers(request, {
    label: [
      `${ROLE_LABEL}=${DATA_HELPER_ROLE}`,
      `${APP_LABEL}=${input.appId}`,
      `${PROVIDER_LABEL}=${input.providerId}`,
    ],
  }).pipe(
    Effect.map((holders) => holders.filter((holder) => isLabeledEphemeralDataHelper(holder.labels, input))),
  );

export const listVolumeHolders = (
  request: HelperRequester,
  volumeName: string,
): Effect.Effect<ReadonlyArray<VolumeHolder>, never> => listContainers(request, { volume: [volumeName] });

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

export const namedHolders = (
  holders: ReadonlyArray<VolumeHolder>,
  providerId: string,
): ReadonlyArray<NamedVolumeHolder> =>
  holders.map((holder) => ({ name: holder.name, kind: classifyVolumeHolder(holder, providerId) }));

export const removeEphemeralDataHelpers = Effect.fnUntraced(function* (
  request: HelperRequester,
  input: { readonly appId: string; readonly providerId: string; readonly stores?: ReadonlyArray<string> },
): Effect.fn.Return<
  { readonly removed: ReadonlyArray<string>; readonly remaining: ReadonlyArray<VolumeHolder> },
  never
> {
  const helpers = yield* listLabeledEphemeralDataHelpers(request, input);
  const removed: string[] = [];
  const remaining: VolumeHolder[] = [];
  for (const helper of helpers) {
    if (!isRemovableHelperState(helper.state)) {
      remaining.push(helper);
      continue;
    }
    if (yield* forceRemoveContainer(request, helper.id)) removed.push(helper.name);
    else remaining.push(helper);
  }
  return { removed, remaining };
});

export const removeUnlabeledEphemeralDataHolders = Effect.fnUntraced(function* (
  request: HelperRequester,
  input: { readonly providerId: string; readonly volumeName: string },
): Effect.fn.Return<
  { readonly removed: ReadonlyArray<string>; readonly remaining: ReadonlyArray<VolumeHolder> },
  never
> {
  const holders = yield* listVolumeHolders(request, input.volumeName);
  const remaining: VolumeHolder[] = [];
  const removed: string[] = [];
  for (const holder of holders) {
    if (
      holder.labels[ROLE_LABEL] !== undefined ||
      !isEphemeralDataHelperName(holder.name, input.providerId)
    ) {
      remaining.push(holder);
      continue;
    }
    const listedMounts =
      holder.mountNames.includes(input.volumeName) ||
      (holder.mountNames.length === 0 && (yield* inspectMountsVolume(request, holder, input.volumeName)));
    if (!listedMounts || !isRemovableHelperState(holder.state)) {
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
): Effect.fn.Return<ReadonlyArray<VolumeHolder>, never> {
  yield* removeEphemeralDataHelpers(request, { ...input, stores: [input.volumeName] });
  const unlabeled = yield* removeUnlabeledEphemeralDataHolders(request, input);
  return unlabeled.remaining;
});
