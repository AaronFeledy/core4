import { sha256Hex } from "@lando/sdk/digest";
import { AppPlacementError } from "@lando/sdk/errors";
import type { AppRef, AppliedAppPlan, EngineIdentity, ProviderId } from "@lando/sdk/schema";
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

export const destroyCommand = (app: Pick<AppRef, "kind" | "id">, provider: ProviderId): string => {
  switch (app.kind) {
    case "global":
      return `lando global:destroy --provider=${provider} --yes`;
    case "scratch":
      return `lando scratch:destroy ${app.id} --keep-volumes --yes`;
    case "user":
      return `lando destroy --provider=${provider} --yes`;
  }
};

export type EnginePlacementRecord = Pick<AppliedAppPlan, "id" | "provider" | "root" | "engineIdentity">;

export interface EnginePlacementCheck {
  readonly provider: { readonly id: string; readonly engineIdentity?: EngineIdentity | undefined };
  readonly kind: AppRef["kind"];
  readonly records: readonly (EnginePlacementRecord | undefined)[];
}

/**
 * The placement refusal for a record that names another engine, or `undefined` when this engine
 * holds (or might hold) every record. Records without an identity and providers without one are
 * not judged: there is nothing to compare.
 */
export const enginePlacementMismatch = (input: EnginePlacementCheck): AppPlacementError | undefined => {
  const current = input.provider.engineIdentity;
  if (current === undefined) return undefined;
  for (const plan of input.records) {
    if (plan === undefined || plan.provider !== input.provider.id) continue;
    const recorded = plan.engineIdentity;
    if (recorded === undefined || matchesEnginePlacement(recorded, current)) continue;
    const app = { kind: input.kind, root: plan.root, id: plan.id };
    const owningEndpoint = engineEndpointDisplay(recorded.endpoint);
    let reconnect = `Restore the connection to ${owningEndpoint}`;
    if (input.provider.id === "docker")
      reconnect += " with `docker context use <name>` or by setting DOCKER_HOST";
    else if (input.provider.id === "podman") reconnect += " by setting DOCKER_HOST";
    const retire =
      input.kind === "scratch"
        ? ` If that engine is gone, run \`lando scratch:destroy ${app.id}\` to retire the scratch. Anything left on the old engine is not removed.`
        : ` If that engine is gone, run \`${destroyCommand(app, plan.provider)}\` to drop Lando's record. Anything left on the old engine is not removed.`;
    return new AppPlacementError({
      app,
      desiredProviderId: input.provider.id,
      realizedProviderId: plan.provider,
      message: `App ${plan.id} was realized at ${owningEndpoint}, but ${engineEndpointDisplay(current.endpoint)} now connects to a different engine.`,
      remediation: `${reconnect}.${retire}`,
    });
  }
  return undefined;
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
