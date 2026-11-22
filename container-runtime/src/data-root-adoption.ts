import { ProviderUnavailableError } from "@lando/sdk/errors";
import { type AppPlan, LANDO_DATA_ROOT_LABEL, planAppIdentity } from "@lando/sdk/schema";
import type { ProviderError } from "@lando/sdk/services";
import { Effect, Option, Schema } from "effect";
import type { EngineHttpRequest, EngineHttpResponse } from "./engine-api.ts";
import { APP_LABEL, STORE_LABEL, VOLUME_INSTANCE_LABEL } from "./labels.ts";
import {
  decodeNativeObservation,
  matchesPrivateNetworkLabels,
  networkOwnershipLabels,
  ownsServiceContainer,
} from "./native-ownership.ts";
import { NativeVolumeSchema } from "./native-volume-identity.ts";
import type { makeResourceOwnershipStore } from "./resource-ownership.ts";
import { type AdoptionBatch, resourcesForPlan } from "./resource-ownership-inventory.ts";
import { STORAGE_SCOPE_LABEL, volumeClassFromLabels } from "./volume-classes.ts";
import { isGlobalCacheStore, volumeOwnershipLabels } from "./volume-ownership.ts";

type AdoptionInput = {
  readonly request: (request: EngineHttpRequest) => Effect.Effect<EngineHttpResponse, ProviderError>;
  readonly store: Pick<ReturnType<typeof makeResourceOwnershipStore>, "load" | "recordAdoption">;
  readonly volumeWitness?: (name: string) => Effect.Effect<string | undefined, ProviderError>;
};

/** Only a prior applied plan supplies candidates; inventory intent never does. */
export const adoptLegacyDataRoot = Effect.fn("DataRootAdoption.adopt")(function* (
  plan: AppPlan,
  previous: AppPlan | undefined,
  input: AdoptionInput,
) {
  const owner = planAppIdentity(plan);
  if (owner.dataRoot === undefined || previous === undefined || previous.identity?.dataRoot !== undefined)
    return;
  const priorOwner = planAppIdentity(previous);
  if (
    owner.appRoot !== priorOwner.appRoot ||
    plan.root !== previous.root ||
    plan.provider !== previous.provider ||
    plan.id !== previous.id
  )
    return;

  const dataRoot = owner.dataRoot;
  const inventory = yield* input.store.load(owner.appRoot);
  if (
    inventory?.adoptions?.some((batch) => batch.dataRoot === dataRoot && batch.previousAppId === previous.id)
  )
    return;

  const receipts: AdoptionBatch["receipts"][number][] = [];
  for (const candidate of resourcesForPlan(previous)) {
    const nativeName = candidate.nativeName;
    const escapedName = encodeURIComponent(nativeName);
    const paths = {
      container: `/containers/${escapedName}/json`,
      network: `/networks/${escapedName}`,
      volume: `/volumes/${escapedName}`,
    } as const;
    const response = yield* input.request({ method: "GET", path: paths[candidate.kind] });
    if (response.status === 404) continue;
    if (response.status !== 200) {
      return yield* new ProviderUnavailableError({
        providerId: plan.provider,
        operation: "data-root-adoption",
        message: `Cannot inspect ${candidate.kind} ${nativeName} for adoption (HTTP ${response.status}).`,
        remediation: "Check the provider connection and retry from this Lando installation.",
      });
    }
    const receipt = {
      nativeName,
      providerId: plan.provider,
      appRoot: owner.appRoot,
      appId: candidate.appId,
      dataRoot,
    };

    if (candidate.kind === "volume") {
      const parsed = Schema.decodeUnknownOption(Schema.fromJsonString(NativeVolumeSchema))(response.body);
      const namedStore = previous.stores.find((entry) => entry.name === nativeName);
      if (Option.isNone(parsed) || parsed.value.Name !== nativeName || namedStore === undefined) continue;
      const labels = parsed.value.Labels ?? {};
      if (labels[LANDO_DATA_ROOT_LABEL] !== undefined) continue;
      if (isGlobalCacheStore(namedStore)) continue;
      if (
        labels[APP_LABEL] !== candidate.appId ||
        labels[STORE_LABEL] !== nativeName ||
        labels[STORAGE_SCOPE_LABEL] !== candidate.volumeScope ||
        volumeClassFromLabels(labels) !== candidate.volumeClass
      )
        continue;
      if (
        !Object.entries(volumeOwnershipLabels(previous, namedStore)).every(
          ([key, value]) => labels[key] === value,
        )
      )
        continue;
      const volumeInstance = labels[VOLUME_INSTANCE_LABEL];
      const witness = yield* input.volumeWitness?.(nativeName) ?? Effect.succeed(undefined);
      if (witness !== undefined && witness !== volumeInstance) continue;
      if (
        inventory?.resources.some(
          (entry) =>
            entry.kind === "volume" &&
            entry.nativeName === nativeName &&
            entry.volumeInstance !== undefined &&
            entry.volumeInstance !== volumeInstance,
        )
      )
        continue;
      receipts.push({
        ...receipt,
        kind: "volume",
        ...(volumeInstance === undefined ? {} : { volumeInstance }),
      });
      continue;
    }

    const observed = decodeNativeObservation(response.body);
    const observedName = observed?.Name ?? observed?.name;
    const nativeId = observed?.Id ?? observed?.ID ?? observed?.id;
    if (observed === undefined || observedName?.replace(/^\//, "") !== nativeName || !nativeId) continue;
    const labels =
      (candidate.kind === "container" ? observed.Config?.Labels : undefined) ??
      observed.Labels ??
      observed.labels ??
      {};
    if (labels[LANDO_DATA_ROOT_LABEL] !== undefined) continue;
    const proven =
      candidate.kind === "container"
        ? ownsServiceContainer(previous, { service: candidate.service, containerId: nativeId, labels })
        : matchesPrivateNetworkLabels(labels, networkOwnershipLabels(previous));
    if (proven) {
      receipts.push({ ...receipt, kind: candidate.kind, nativeId });
    }
  }
  yield* input.store.recordAdoption(owner.appRoot, { previousAppId: previous.id, dataRoot, receipts });
});
