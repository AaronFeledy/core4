import { Option, Schema } from "effect";

import { AbsolutePath, type VolumeCreationFact } from "@lando/sdk/schema";

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
