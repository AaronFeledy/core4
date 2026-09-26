import { randomUUID } from "node:crypto";

import { Option, Schema } from "effect";

import { AbsolutePath, type AppPlan, type VolumeCreationFact } from "@lando/sdk/schema";

import { STORAGE_KIND_LABEL, STORAGE_SCOPE_LABEL } from "./volume-classes.ts";
import { volumeOwnershipLabels } from "./volume-ownership.ts";

const scratchVolumeLabels = (plan: Pick<AppPlan, "id" | "extensions">): Readonly<Record<string, string>> => {
  const scratch = plan.extensions["@lando/core/scratch"];
  const scratchId = typeof scratch === "object" && scratch !== null ? Reflect.get(scratch, "id") : undefined;
  return scratchId === plan.id && typeof scratchId === "string"
    ? { "dev.lando.scratch": "TRUE", "dev.lando.scratch-id": scratchId }
    : {};
};

export const volumeCreationLabels = (
  plan: Pick<AppPlan, "id" | "provider" | "root" | "identity" | "extensions">,
  store: AppPlan["stores"][number],
): Readonly<Record<string, string>> => ({
  "dev.lando.app": plan.id,
  "dev.lando.store": store.name,
  [STORAGE_SCOPE_LABEL]: store.scope,
  "dev.lando.volume-instance": randomUUID(),
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
  const generation = input.labels["dev.lando.volume-instance"];
  const owner = input.labels["dev.lando.volume-owner"];
  if (
    !generation ||
    !owner ||
    volume.Name !== input.name ||
    volume.Labels["dev.lando.volume-instance"] !== generation ||
    volume.Labels["dev.lando.volume-owner"] !== owner
  )
    return [];
  const root = Schema.decodeUnknownOption(AbsolutePath)(owner);
  return Option.isSome(root) ? [{ nativeName: volume.Name, generation, ownerRoot: root.value }] : [];
};
