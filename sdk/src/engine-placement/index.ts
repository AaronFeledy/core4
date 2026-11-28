import { sha256Hex } from "../digest/index.ts";
import { AppPlacementError } from "../errors/app.ts";
import type { AppRef, AppliedAppPlan, EngineIdentity, ProviderId } from "../schema/index.ts";

/** Windows named-pipe spelling shared by the transport adapters and endpoint identity. */
export const normalizeNamedPipePath = (socketPath: string): string => {
  if (!socketPath.startsWith("npipe:")) return socketPath;
  const pipePath = socketPath.slice("npipe:".length);
  const [, desktopPipe] = pipePath.match(/^\/{2,4}\.\/pipe\/(.+)$/u) ?? [];
  return desktopPipe === undefined ? pipePath : `\\\\.\\pipe\\${desktopPipe.replaceAll("/", "\\")}`;
};

/** A URL-shaped Docker endpoint's explicit API prefix, which may be secret. */
export const explicitDockerApiPrefixFromHost = (dockerHost: string): string | undefined => {
  const url = dockerHttpBaseUrl(dockerHost);
  if (!url.startsWith("http://") && !url.startsWith("https://")) return undefined;
  return URL.parse(url)?.pathname.replace(/\/+$/u, "") || undefined;
};

/** The HTTP base URL a Docker endpoint reaches over TCP. */
export const dockerHttpBaseUrl = (dockerHost: string): string => {
  if (dockerHost.startsWith("tcp://")) return `http://${dockerHost.slice("tcp://".length)}`;
  return dockerHost;
};

/** One spelling per socket, so every provider that reaches the same engine shares a key. */
export const dockerApiEndpointKey = (dockerHost: string): string => {
  if (dockerHost.startsWith("npipe:") || dockerHost.startsWith("\\\\.\\pipe\\")) {
    return `npipe:${normalizeNamedPipePath(dockerHost)}`;
  }
  if (dockerHost.startsWith("unix://")) return `unix:${dockerHost.slice("unix://".length)}`;
  if (dockerHost.startsWith("/")) return `unix:${dockerHost}`;
  const tcp = dockerHost.startsWith("tcp://");
  if (!tcp && !dockerHost.startsWith("http://") && !dockerHost.startsWith("https://")) return dockerHost;
  const parsed = URL.parse(dockerHttpBaseUrl(dockerHost));
  return parsed === null ? dockerHost : `${tcp ? "tcp:" : parsed.protocol}//${parsed.host}`;
};

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

/** The redacted connection spelling a message may name, preserving a recorded prefix digest. */
export const engineEndpointDisplay = (endpoint: string): string => connectionLabel(endpoint, true);

/** The identity a provider records from its construction-time observation. */
export const engineIdentityFor = (parts: readonly string[], endpoint: string): EngineIdentity => ({
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

/** Refuse only when both the record and provider identify their engines. */
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
