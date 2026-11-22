import { matchesDataRoot } from "@lando/container-runtime/native-ownership";
import { LANDO_DATA_ROOT_LABEL } from "@lando/sdk/schema";
import { PathsService, type ProviderRuntimeSnapshot } from "@lando/sdk/services";
import { Effect } from "effect";
import { canonicalMissingAppRoot } from "./app-mutation-lock.ts";

export const currentDataRoot = Effect.flatMap(PathsService, (paths) =>
  canonicalMissingAppRoot(paths.roots.userDataRoot),
);

/**
 * Whether an observed data-root label belongs to `dataRoot`. Unlabeled observations
 * match only when `recorded` is true: a local applied plan or inventory-only ownership
 * record is the historical proof, matching `matchesDataRoot` elsewhere.
 */
export const belongsToDataRoot = (
  observed: string | undefined,
  dataRoot: string,
  recorded: boolean,
): boolean => matchesDataRoot(observed, dataRoot, recorded);

/**
 * Applied plans and inventory records without a data root are historical local state for
 * this installation; stamped plans match only their own data root.
 */
export const planBelongsToDataRoot = (
  plan: {
    readonly identity?:
      | {
          readonly dataRoot?: string | undefined;
          readonly appRoot?: string | undefined;
          readonly ownerKey?: string | undefined;
        }
      | undefined;
  },
  dataRoot: string,
): boolean => matchesDataRoot(plan.identity?.dataRoot, dataRoot, true);

/** One scoped ownership proof: member name (service or volume native name) plus provider/root. */
export type ScopedOwnershipRecord = {
  readonly providerId: string;
  readonly appRoot: string;
  readonly appId: string;
  readonly kind: "service" | "volume";
  /** Service name or volume native name. */
  readonly member: string;
  /** Optional native container/volume id when the inventory recorded one. */
  readonly nativeId?: string;
};

export type ScopedOwnershipSource = {
  readonly providerId: string;
  readonly root: string;
  readonly appId: string;
  readonly services?: ReadonlyArray<string>;
  readonly volumes?: ReadonlyArray<string>;
  readonly members?: ReadonlyArray<{
    readonly kind: "container" | "volume" | "network" | "service";
    readonly nativeName: string;
    readonly appId: string;
    readonly service?: string;
  }>;
};

/** Expand plan-shaped or inventory-shaped sources into member-scoped records. */
export const scopedOwnershipRecords = (
  sources: ReadonlyArray<ScopedOwnershipSource>,
): ReadonlyArray<ScopedOwnershipRecord> => {
  const records: ScopedOwnershipRecord[] = [];
  for (const source of sources) {
    for (const service of source.services ?? []) {
      records.push({
        providerId: source.providerId,
        appRoot: source.root,
        appId: source.appId,
        kind: "service",
        member: service,
      });
    }
    for (const volume of source.volumes ?? []) {
      records.push({
        providerId: source.providerId,
        appRoot: source.root,
        appId: source.appId,
        kind: "volume",
        member: volume,
      });
    }
    for (const member of source.members ?? []) {
      if (member.kind === "network") continue;
      if (member.kind === "container" || member.kind === "service") {
        const service = member.service ?? member.nativeName;
        records.push({
          providerId: source.providerId,
          appRoot: source.root,
          appId: member.appId,
          kind: "service",
          member: service,
          nativeId: member.nativeName,
        });
        continue;
      }
      records.push({
        providerId: source.providerId,
        appRoot: source.root,
        appId: member.appId,
        kind: "volume",
        member: member.nativeName,
        nativeId: member.nativeName,
      });
    }
  }
  return records;
};

export const recordsFromAppliedPlans = (
  plans: ReadonlyArray<{
    readonly id: string;
    readonly provider: string;
    readonly root: string;
    readonly identity?: { readonly dataName?: string } | undefined;
    readonly services: Readonly<Record<string, unknown>>;
    readonly stores: ReadonlyArray<{ readonly name: string }>;
  }>,
): ReadonlyArray<ScopedOwnershipRecord> =>
  scopedOwnershipRecords(
    plans.map((plan) => {
      // Mirror planDataId without branded AppPlan: dataName replaces id for volume app refs.
      const dataId = plan.identity?.dataName ?? plan.id;
      return {
        providerId: plan.provider,
        root: plan.root,
        appId: plan.id,
        services: Object.keys(plan.services),
        volumes: dataId === plan.id ? plan.stores.map((store) => store.name) : [],
        members: plan.stores.map((store) => ({
          kind: "volume" as const,
          nativeName: store.name,
          appId: dataId,
        })),
      };
    }),
  );

/**
 * True when a scoped local record claims this runtime member under provider/root.
 * Broad ownership inventory presence is not enough: member name (or native id) is required.
 */
export const hasScopedOwnershipRecord = (
  records: ReadonlyArray<ScopedOwnershipRecord>,
  query: {
    readonly providerId: string;
    readonly appRoot: string | undefined;
    readonly appId: string;
    readonly kind: "service" | "volume";
    readonly member: string;
    readonly nativeId?: string;
  },
): boolean => {
  if (query.appRoot === undefined) return false;
  return records.some(
    (record) =>
      record.providerId === query.providerId &&
      record.appRoot === query.appRoot &&
      record.appId === query.appId &&
      record.kind === query.kind &&
      (record.member === query.member ||
        (query.nativeId !== undefined &&
          (record.nativeId === query.nativeId || record.member === query.nativeId))),
  );
};

export const scopeRuntimeSnapshot = (
  snapshot: ProviderRuntimeSnapshot,
  dataRoot: string,
  ownership: ReadonlyArray<ScopedOwnershipRecord> = [],
): ProviderRuntimeSnapshot => {
  const appliedPlans = snapshot.appliedPlans.filter((plan) => planBelongsToDataRoot(plan, dataRoot));
  const records = [...recordsFromAppliedPlans(appliedPlans), ...ownership];
  const owns = (
    labels: Readonly<Record<string, string>> | undefined,
    query: {
      readonly providerId: string;
      readonly appRoot: string | undefined;
      readonly appId: string;
      readonly kind: "service" | "volume";
      readonly member: string;
      readonly nativeId?: string;
    },
  ) => belongsToDataRoot(labels?.[LANDO_DATA_ROOT_LABEL], dataRoot, hasScopedOwnershipRecord(records, query));
  return {
    ...snapshot,
    appliedPlans,
    services: snapshot.services.filter((service) =>
      owns(service.labels, {
        providerId: service.providerId,
        appRoot: service.appRoot,
        appId: service.app,
        kind: "service",
        member: service.service,
        ...(service.containerId === undefined ? {} : { nativeId: service.containerId }),
      }),
    ),
    volumes: snapshot.volumes.filter(
      (volume) =>
        volume.identity !== undefined &&
        owns(volume.labels, {
          providerId: snapshot.providerId,
          appRoot: volume.identity.ownerRoot,
          appId: volume.ref.app,
          kind: "volume",
          member: volume.identity.nativeName,
          nativeId: volume.identity.nativeName,
        }),
    ),
  };
};
