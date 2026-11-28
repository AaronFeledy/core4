import { engineIdentityFor } from "@lando/sdk/engine-placement";
import { Option, Schema } from "effect";

const Libpod = Schema.Struct({
  host: Schema.Struct({ hostname: Schema.NonEmptyString }),
  store: Schema.Struct({ graphRoot: Schema.NonEmptyString }),
});
const CompatiblePodman = Schema.Struct({ BuildahVersion: Schema.Unknown });
const CompatibleStorage = Schema.Struct({
  Name: Schema.NonEmptyString,
  DockerRootDir: Schema.NonEmptyString,
});
const Docker = Schema.Struct({ ID: Schema.NonEmptyString });

// Podman's compatibility ID is random per request. Both API dialects describe
// the same backing store by the host's name and graph root, not its run dir.
export const podmanEngineIdentity = (info: unknown, endpoint: string) => {
  const result = Schema.decodeUnknownOption(Libpod)(info);
  return Option.isNone(result)
    ? undefined
    : engineIdentityFor(["podman", result.value.host.hostname, result.value.store.graphRoot], endpoint);
};

export const dockerEngineIdentity = (info: unknown, endpoint: string) => {
  if (Schema.is(CompatiblePodman)(info)) {
    const result = Schema.decodeUnknownOption(CompatibleStorage)(info);
    return Option.isNone(result)
      ? undefined
      : engineIdentityFor(["podman", result.value.Name, result.value.DockerRootDir], endpoint);
  }
  const result = Schema.decodeUnknownOption(Docker)(info);
  return Option.isNone(result) ? undefined : engineIdentityFor(["docker", result.value.ID], endpoint);
};
