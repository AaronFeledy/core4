import { sha256Hex } from "@lando/sdk/digest";
import type { EngineIdentity } from "@lando/sdk/schema";
import { Option, Schema } from "effect";
import {
  dockerApiEndpointKey,
  dockerHttpBaseUrl,
  explicitDockerApiPrefixFromHost,
} from "./docker/api-prefix.ts";

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

const connectionLabel = (endpoint: string, recorded = false): string => {
  const url = URL.parse(endpoint);
  // Remote connection strings can carry credentials, including in userinfo and query parameters.
  if (url === null)
    return endpoint.startsWith("/") || endpoint.startsWith("\\\\.\\pipe\\") ? endpoint : "unknown endpoint";
  if (url.protocol === "unix:" || url.protocol === "npipe:")
    return `${url.protocol}//${url.host}${url.pathname}`;
  // A proxy can route different prefixes to different daemons, but the prefix itself can be secret.
  const prefix = explicitDockerApiPrefixFromHost(endpoint);
  const address = `${url.protocol}//${url.host}`;
  if (prefix !== undefined) return `${address}#prefix=${sha256Hex(prefix)}`;
  return recorded && /^#prefix=[a-f0-9]{64}$/u.test(url.hash) ? address + url.hash : address;
};

export const engineEndpointDisplay = (endpoint: string): string => connectionLabel(endpoint, true);

const identity = (parts: readonly string[], endpoint: string): EngineIdentity => ({
  fingerprint: sha256Hex(JSON.stringify(parts)),
  endpoint: connectionLabel(endpoint),
});

const canonicalConnection = (endpoint: string): string | undefined => {
  const label = engineEndpointDisplay(endpoint);
  if (label === "unknown endpoint") return undefined;
  return dockerApiEndpointKey(dockerHttpBaseUrl(label)) + (URL.parse(label)?.hash ?? "");
};

// A replacement at the same address can reconcile; the same store at another address is an alias.
export const matchesEnginePlacement = (recorded: EngineIdentity, current: EngineIdentity): boolean => {
  if (recorded.fingerprint === current.fingerprint) return true;
  const endpoint = canonicalConnection(recorded.endpoint);
  return endpoint !== undefined && endpoint === canonicalConnection(current.endpoint);
};

// Podman's compatibility ID is random per request. Both API dialects describe
// the same backing store by the host's name and graph root, not its run dir.
export const podmanEngineIdentity = (info: unknown, endpoint: string) => {
  const result = Schema.decodeUnknownOption(Libpod)(info);
  return Option.isNone(result)
    ? undefined
    : identity(["podman", result.value.host.hostname, result.value.store.graphRoot], endpoint);
};

export const dockerEngineIdentity = (info: unknown, endpoint: string) => {
  if (Schema.is(CompatiblePodman)(info)) {
    const result = Schema.decodeUnknownOption(CompatibleStorage)(info);
    return Option.isNone(result)
      ? undefined
      : identity(["podman", result.value.Name, result.value.DockerRootDir], endpoint);
  }
  const result = Schema.decodeUnknownOption(Docker)(info);
  return Option.isNone(result) ? undefined : identity(["docker", result.value.ID], endpoint);
};
