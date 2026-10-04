import type { LandoPluginModule } from "@lando/sdk/plugins";
import { Effect } from "effect";
import {
  type PluginCapabilityIndex,
  type PluginCapabilityIndexError,
  makePluginCapabilityIndex,
} from "./module-set.ts";

type CapabilityKey = {
  [Key in keyof PluginCapabilityIndex]: PluginCapabilityIndex[Key] extends ReadonlyMap<unknown, unknown>
    ? Key
    : never;
}[keyof PluginCapabilityIndex];

export const indexContributions = <Key extends CapabilityKey, E>(
  modules: ReadonlyArray<LandoPluginModule>,
  key: Key,
  onIndexError: (error: PluginCapabilityIndexError) => E,
): Effect.Effect<PluginCapabilityIndex[Key], E> =>
  Effect.fromResult(makePluginCapabilityIndex(modules)).pipe(
    Effect.mapError(onIndexError),
    Effect.map((index) => index[key]),
  );

export const selectRegistration = <A, E>(options: {
  readonly registrations: ReadonlyMap<string, A>;
  readonly id: string;
  readonly onMissing: (id: string) => E;
}): Effect.Effect<{ readonly id: string; readonly registration: A }, E> => {
  const registration = options.registrations.get(options.id);
  return registration === undefined
    ? Effect.fail(options.onMissing(options.id))
    : Effect.succeed({ id: options.id, registration });
};
