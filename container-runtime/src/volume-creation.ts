import { randomUUID } from "node:crypto";
import {
  APP_LABEL,
  SCRATCH_ID_LABEL,
  SCRATCH_LABEL,
  STORE_LABEL,
  VOLUME_INSTANCE_LABEL,
  VOLUME_OWNER_LABEL,
} from "./labels.ts";

import { Option, Schema } from "effect";

import { AbsolutePath, type AppPlan, type VolumeCreationFact } from "@lando/sdk/schema";

import { STORAGE_KIND_LABEL, STORAGE_SCOPE_LABEL } from "./volume-classes.ts";
import { volumeOwnershipLabels } from "./volume-ownership.ts";

const scratchVolumeLabels = (plan: Pick<AppPlan, "id" | "extensions">): Readonly<Record<string, string>> => {
  const scratch = plan.extensions["@lando/core/scratch"];
  const scratchId = typeof scratch === "object" && scratch !== null ? Reflect.get(scratch, "id") : undefined;
  return scratchId === plan.id && typeof scratchId === "string"
    ? { [SCRATCH_LABEL]: "TRUE", [SCRATCH_ID_LABEL]: scratchId }
    : {};
};

export const volumeCreationLabels = (
  plan: Pick<AppPlan, "id" | "provider" | "root" | "identity" | "extensions">,
  store: AppPlan["stores"][number],
): Readonly<Record<string, string>> => ({
  [APP_LABEL]: plan.id,
  [STORE_LABEL]: store.name,
  [STORAGE_SCOPE_LABEL]: store.scope,
  [VOLUME_INSTANCE_LABEL]: randomUUID(),
  ...volumeOwnershipLabels(plan, store),
  ...scratchVolumeLabels(plan),
  ...(store.kind === "cache" ? { [STORAGE_KIND_LABEL]: "cache" } : {}),
});

const CreatedVolume = Schema.parseJson(
  Schema.Struct({
    Name: Schema.String,
    Labels: Schema.Record({ key: Schema.String, value: Schema.String }),
  }),
);

/** A fresh random request token echoed by the daemon proves this create won, unlike HTTP 201. */
export const volumeCreationFact = (input: {
  readonly body: string;
  readonly name: string;
  readonly labels: Readonly<Record<string, string>>;
}): readonly VolumeCreationFact[] => {
  const decoded = Schema.decodeUnknownOption(CreatedVolume)(input.body);
  if (Option.isNone(decoded)) return [];
  const volume = decoded.value;
  const generation = input.labels[VOLUME_INSTANCE_LABEL];
  const owner = input.labels[VOLUME_OWNER_LABEL];
  if (
    !generation ||
    !owner ||
    volume.Name !== input.name ||
    volume.Labels[VOLUME_INSTANCE_LABEL] !== generation ||
    volume.Labels[VOLUME_OWNER_LABEL] !== owner
  )
    return [];
  const root = Schema.decodeUnknownOption(AbsolutePath)(owner);
  return Option.isSome(root) ? [{ nativeName: volume.Name, generation, ownerRoot: root.value }] : [];
};
