import { mapFailures } from "@lando/sdk/command-result";
import { canonicalJson } from "@lando/sdk/digest";
import { ProviderUnavailableError, StateStoreError } from "@lando/sdk/errors";
import type { PluginStateStore } from "@lando/sdk/plugins";
import {
  type AbsolutePath,
  type AppPlan,
  ProviderId,
  type ResourceOwnership,
  landoOwnedNetworkNames,
  planAppIdentity,
} from "@lando/sdk/schema";
import { Effect, Schema } from "effect";
import { SCRATCH_ID_LABEL, scratchLabelsForPlan } from "./labels.ts";
import { isSharedNetwork } from "./native-ownership.ts";
import {
  type AdoptionBatch,
  ResourceOwnershipInventory as Inventory,
  type OwnedResource,
  RESOURCE_OWNERSHIP_NAMESPACE,
  RESOURCE_OWNERSHIP_VERSION,
  type ResourceInventory,
  legacyResourceDigest,
  ownershipFailure,
  resourcesForPlan,
  validate,
} from "./resource-ownership-inventory.ts";

export {
  OwnedResource,
  RESOURCE_OWNERSHIP_VERSION,
  type ResourceInventory,
  ResourceOwnershipInventory,
  ownershipFailure,
} from "./resource-ownership-inventory.ts";

const keyFor = (resource: OwnedResource) => resource.identityDigest;
const inventoryKey = (root: AbsolutePath) => `${planAppIdentity({ root }).ownerKey}.json`;

export const makeResourceOwnershipStore = (providerId: string, state?: PluginStateStore) => {
  const open = (key: string) =>
    state === undefined
      ? Effect.fail(ownershipFailure(providerId))
      : state
          .open({
            namespace: RESOURCE_OWNERSHIP_NAMESPACE,
            key,
            schema: Inventory,
            version: RESOURCE_OWNERSHIP_VERSION,
            codec: "json",
            mode: 0o600,
            lock: "advisory",
            onCorrupt: "fail",
            onVersionMismatch: (raw, version): ResourceInventory => {
              if (version === 1 || version === 2) {
                const { adoptions: _adoptions, ...legacy } = Schema.decodeUnknownSync(Inventory)(raw);
                return legacy;
              }
              throw new StateStoreError({
                reason: "version",
                operation: "resource-ownership",
                cause: version,
                remediation:
                  "Upgrade Lando or clear the resource-ownership state written by an incompatible build.",
              });
            },
          })
          .pipe(mapFailures((cause) => ownershipFailure(providerId, cause)));
  const loadRecord = Effect.fn("ResourceOwnership.loadRecord")(function* (key: string, root?: AbsolutePath) {
    const bucket = yield* open(key);
    const value = yield* bucket.get.pipe(mapFailures((cause) => ownershipFailure(providerId, cause)));
    return yield* Effect.try({
      try: () => {
        if (value === null) return undefined;
        if (inventoryKey(value.appRoot) !== key) throw ownershipFailure(providerId);
        return validate(value, root ?? value.appRoot, providerId);
      },
      catch: (cause) => ownershipFailure(providerId, cause),
    });
  });
  const load = (root: AbsolutePath) => loadRecord(inventoryKey(root), root);
  const prepare = Effect.fn("ResourceOwnership.prepare")(function* (plan: AppPlan, previous?: AppPlan) {
    const owner = planAppIdentity(plan);
    const root = owner.appRoot;
    if (
      plan.root !== root ||
      owner.ownerKey !== planAppIdentity({ root }).ownerKey ||
      plan.provider !== providerId
    )
      return yield* Effect.fail(ownershipFailure(providerId));
    if (previous !== undefined && previous.root !== root) {
      const previousOwner = planAppIdentity(previous);
      if (
        previous.provider !== providerId ||
        previous.id !== plan.id ||
        previousOwner.appRoot !== previous.root ||
        previousOwner.ownerKey !== planAppIdentity({ root: previous.root }).ownerKey
      )
        return yield* Effect.fail(ownershipFailure(providerId));
      return yield* Effect.fail(
        new ProviderUnavailableError({
          providerId,
          operation: "resource-ownership",
          message: `App name ${plan.name} is still assigned to the project at ${previous.root}. Stopping that project does not release its name.`,
          remediation:
            "Change `name:` in this project's .lando.yml and run `lando start` again. To release the runtime name instead, run `lando destroy` from the other project, only if you intend to tear it down.",
          details: { root: previous.root, app: previous.id, name: plan.name, reason: "name-reserved" },
        }),
      );
    }
    const resources: OwnedResource[] = [];
    for (const attempt of previous === undefined ? [plan] : [previous, plan]) {
      const attemptOwner = planAppIdentity(attempt);
      if (
        attempt.root !== root ||
        attempt.provider !== providerId ||
        attemptOwner.appRoot !== root ||
        attemptOwner.ownerKey !== owner.ownerKey
      )
        return yield* Effect.fail(ownershipFailure(providerId));
      resources.push(...resourcesForPlan(attempt));
    }
    const bucket = yield* open(inventoryKey(root));
    yield* bucket
      .modify((current) => {
        if (current !== null) validate(current, root, providerId);
        const networkSlot = (item: OwnedResource) =>
          item.kind === "network"
            ? canonicalJson({
                appRoot: item.appRoot,
                ownerKey: item.ownerKey,
                providerId: item.providerId,
                appId: item.appId,
                nativeName: item.nativeName,
                role: item.role ?? null,
              })
            : undefined;
        const finalScratchId = scratchLabelsForPlan(plan)[SCRATCH_ID_LABEL];
        const finalNetworkNames = new Set(
          landoOwnedNetworkNames(plan).filter((name) => !isSharedNetwork(plan, name)),
        );
        const finalScratchSlots = new Set(
          finalScratchId === undefined
            ? []
            : resources
                .filter(
                  (item) =>
                    item.kind === "network" &&
                    item.scratchId === finalScratchId &&
                    finalNetworkNames.has(item.nativeName) &&
                    (item.role === "authored") ===
                      !!plan.networking?.authoredNetworks?.some(
                        (network) => !network.external && network.name === item.nativeName,
                      ),
                )
                .map((item) => networkSlot(item)),
        );
        const unionByKey = new Map<string, OwnedResource>();
        for (const item of [...(current?.resources ?? []), ...resources]) {
          const slot = networkSlot(item);
          const key = slot === undefined ? `resource:${keyFor(item)}` : `network:${slot}`;
          const existing = unionByKey.get(key);
          if (slot !== undefined && existing?.kind === "network" && item.kind === "network") {
            if (existing.scratchId !== undefined && item.scratchId === undefined) {
              // A prior scratch proof cannot be downgraded by an ordinary plan.
              // A previous ordinary attempt is allowed only when the final plan restores proof.
              if (!finalScratchSlots.has(slot)) throw ownershipFailure(providerId);
              continue;
            }
            if (
              existing.scratchId !== undefined &&
              item.scratchId !== undefined &&
              existing.scratchId !== item.scratchId
            )
              throw ownershipFailure(providerId);
          }
          unionByKey.set(key, item);
        }
        const scoped = new Set(
          [...unionByKey.values()]
            .filter((item) => item.dataRoot === owner.dataRoot && item.dataRoot !== undefined)
            .map(legacyResourceDigest),
        );
        const union = [...unionByKey.values()].filter(
          (item) => item.dataRoot !== undefined || !scoped.has(item.identityDigest),
        );
        return [
          undefined,
          {
            appRoot: root,
            ownerKey: owner.ownerKey,
            providerId: plan.provider,
            appIds: [...new Set(union.map((item) => item.appId))],
            resources: union,
            ...(current?.adoptions === undefined ? {} : { adoptions: current.adoptions }),
          },
        ];
      })
      .pipe(
        mapFailures((cause) => ownershipFailure(providerId, cause)),
        Effect.catchDefect((defect) =>
          Schema.is(ProviderUnavailableError)(defect) ? Effect.fail(defect) : Effect.die(defect),
        ),
      );
  });
  const retire = Effect.fn("ResourceOwnership.retire")(function* (
    root: AbsolutePath,
    resource: OwnedResource,
  ) {
    const bucket = yield* open(inventoryKey(root));
    yield* bucket
      .mutate((current) =>
        Effect.try({
          try: () => {
            // Another cleanup may already have retired the last member and removed the file.
            if (current === null) return { _tag: "Keep" as const, result: undefined };
            validate(current, root, providerId);
            const resources = current.resources.filter((item) => keyFor(item) !== keyFor(resource));
            // An empty batch still records that a data root's legacy adoption was checked.
            const adoptions = (current.adoptions ?? []).map((batch) => ({
              ...batch,
              receipts: batch.receipts.filter(
                (receipt) =>
                  receipt.kind !== resource.kind ||
                  receipt.nativeName !== resource.nativeName ||
                  receipt.appId !== resource.appId,
              ),
            }));
            if (resources.length === 0 && adoptions.length === 0)
              return { _tag: "Remove" as const, result: undefined };
            return {
              _tag: "Set" as const,
              value: {
                ...current,
                resources,
                appIds: [...new Set(resources.map((item) => item.appId))],
                ...(adoptions.length === 0 ? {} : { adoptions }),
              },
              result: undefined,
            };
          },
          catch: (cause) => ownershipFailure(providerId, cause),
        }),
      )
      .pipe(mapFailures((cause) => ownershipFailure(providerId, cause)));
  });
  const recordAdoption = Effect.fn("ResourceOwnership.recordAdoption")(function* (
    root: AbsolutePath,
    batch: AdoptionBatch,
    verifiedVolumes: readonly OwnedResource[],
  ) {
    const bucket = yield* open(inventoryKey(root));
    yield* bucket
      .modify((current) => {
        const existing = current === null ? undefined : validate(current, root, providerId);
        const adoptions = existing?.adoptions ?? [];
        if (
          existing !== undefined &&
          adoptions.some(
            (entry) => entry.dataRoot === batch.dataRoot && entry.previousAppId === batch.previousAppId,
          )
        ) {
          return [undefined, existing];
        }
        const resources = [
          ...new Map(
            [...(existing?.resources ?? []), ...verifiedVolumes].map((item) => [keyFor(item), item]),
          ).values(),
        ];
        return [
          undefined,
          validate(
            {
              appRoot: root,
              ownerKey: planAppIdentity({ root }).ownerKey,
              providerId: ProviderId.make(providerId),
              ...existing,
              appIds: [...new Set(resources.map((item) => item.appId))],
              resources,
              adoptions: [...adoptions, batch],
            },
            root,
            providerId,
          ),
        ];
      })
      .pipe(mapFailures((cause) => ownershipFailure(providerId, cause)));
  });
  return {
    load,
    loadRecord,
    prepare,
    retire,
    recordAdoption,
    summary: (root: AbsolutePath) => load(root).pipe(Effect.map(resourceOwnershipSummary)),
  };
};

/** The public summary of one inventory; an inventory with no members has none. */
export const resourceOwnershipSummary = (
  inventory: ResourceInventory | undefined,
): ResourceOwnership | undefined =>
  inventory === undefined ||
  (inventory.resources.length === 0 && !inventory.adoptions?.some((batch) => batch.receipts.length > 0))
    ? undefined
    : {
        appRoot: inventory.appRoot,
        ownerKey: inventory.ownerKey,
        providerId: inventory.providerId,
        appIds: [
          ...new Set([
            ...inventory.appIds,
            ...(inventory.adoptions ?? []).flatMap((batch) => batch.receipts.map((receipt) => receipt.appId)),
          ]),
        ],
        members: [
          ...inventory.resources.map((resource) => ({
            kind: resource.kind,
            nativeName: resource.nativeName,
            appId: resource.appId,
            ...(resource.kind === "container" ? { service: resource.service } : {}),
          })),
          ...(inventory.adoptions ?? []).flatMap((batch) =>
            batch.receipts.map((receipt) => ({
              kind: receipt.kind,
              nativeName: receipt.nativeName,
              appId: receipt.appId,
              dataRoot: receipt.dataRoot,
              ...(receipt.kind === "volume"
                ? receipt.volumeInstance === undefined
                  ? {}
                  : { volumeInstance: receipt.volumeInstance }
                : { nativeId: receipt.nativeId }),
            })),
          ),
        ],
      };
