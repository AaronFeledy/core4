import { normalizeNamedPipePath } from "../transport.ts";
import {
  type DockerApiNegotiationFail,
  dockerApiPrefixFor,
  dockerApiVersionFromPrefix,
  extractDockerDaemonApiRange,
  isDockerApiVersionRejection,
  negotiateDockerApiVersion,
  parseDockerApiVersionOverride,
} from "./api-version.ts";

export type DockerApiPrefixSource = "explicit" | "env" | "negotiated" | "preferred";

export interface ResolvedDockerApiPrefix {
  readonly prefix: string;
  readonly source: DockerApiPrefixSource;
  readonly version?: string;
}

export interface DockerApiPrefixLearnResult {
  readonly prefix: string;
  readonly retry: boolean;
  readonly failure?: DockerApiNegotiationFail;
}

const prefixCache = new Map<string, ResolvedDockerApiPrefix>();
const prefixFlights = new Map<string, Promise<void>>();

export const resetDockerApiPrefixCache = (): void => {
  prefixCache.clear();
  prefixFlights.clear();
};

export const peekDockerApiPrefix = (key: string): ResolvedDockerApiPrefix | undefined => prefixCache.get(key);

export const rememberDockerApiPrefix = (key: string, resolved: ResolvedDockerApiPrefix): void => {
  prefixCache.set(key, resolved);
};

export const forgetDockerApiPrefix = (key: string): void => {
  prefixCache.delete(key);
};

export const resolvedPrefix = (prefix: string, source: DockerApiPrefixSource): ResolvedDockerApiPrefix => {
  const version = dockerApiVersionFromPrefix(prefix);
  return version === undefined ? { prefix, source } : { prefix, source, version };
};

export const runDockerApiPrefixFlight = async <A>(
  key: string,
  owner: () => Promise<A>,
  waiter: () => Promise<A>,
): Promise<A> => {
  const existing = prefixFlights.get(key);
  if (existing !== undefined) {
    await existing;
    return waiter();
  }
  let release = (): void => undefined;
  const flight = new Promise<void>((resolve) => {
    release = resolve;
  });
  prefixFlights.set(key, flight);
  try {
    return await owner();
  } finally {
    if (prefixFlights.get(key) === flight) prefixFlights.delete(key);
    release();
  }
};

export const isDockerApiPrefixFailure = (
  value: ResolvedDockerApiPrefix | DockerApiNegotiationFail,
): value is DockerApiNegotiationFail => "ok" in value && value.ok === false;

const prefixFromPathname = (pathname: string): string | undefined => {
  const trimmed = pathname.replace(/\/+$/u, "");
  return trimmed === "" || trimmed === "/" ? undefined : trimmed;
};

export const explicitDockerApiPrefixFromHost = (dockerHost: string): string | undefined => {
  if (dockerHost.startsWith("tcp://")) {
    try {
      return prefixFromPathname(new URL(`http://${dockerHost.slice("tcp://".length)}`).pathname);
    } catch {
      return undefined;
    }
  }
  if (dockerHost.startsWith("http://") || dockerHost.startsWith("https://")) {
    try {
      return prefixFromPathname(new URL(dockerHost).pathname);
    } catch {
      return undefined;
    }
  }
  return undefined;
};

export const dockerHttpBaseUrl = (dockerHost: string): string => {
  if (dockerHost.startsWith("tcp://")) return `http://${dockerHost.slice("tcp://".length)}`;
  return dockerHost;
};

export const dockerApiEndpointKey = (dockerHost: string): string => {
  if (dockerHost.startsWith("npipe:") || dockerHost.startsWith("\\\\.\\pipe\\")) {
    return `npipe:${normalizeNamedPipePath(dockerHost)}`;
  }
  if (dockerHost.startsWith("unix://")) return `unix:${dockerHost.slice("unix://".length)}`;
  if (dockerHost.startsWith("/")) return `unix:${dockerHost}`;
  if (dockerHost.startsWith("tcp://")) {
    try {
      const parsed = new URL(`http://${dockerHost.slice("tcp://".length)}`);
      return `tcp://${parsed.host}`;
    } catch {
      return dockerHost;
    }
  }
  if (dockerHost.startsWith("http://") || dockerHost.startsWith("https://")) {
    try {
      const parsed = new URL(dockerHost);
      return `${parsed.protocol}//${parsed.host}`;
    } catch {
      return dockerHost;
    }
  }
  return dockerHost;
};

export const dockerApiPrefixFromEnv = (
  env: Readonly<Record<string, string | undefined>> = process.env,
): DockerApiNegotiationFail | ResolvedDockerApiPrefix | undefined => {
  const raw = env.DOCKER_API_VERSION;
  if (raw === undefined || raw.trim() === "") return undefined;
  const parsed = parseDockerApiVersionOverride(raw);
  if (!parsed.ok) return parsed;
  return { prefix: parsed.prefix, source: "env", version: parsed.version };
};

export const resolveInitialDockerApiPrefix = (input: {
  readonly endpointKey: string;
  readonly explicitPrefix?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly preferredPrefix: string;
}): DockerApiNegotiationFail | ResolvedDockerApiPrefix => {
  const cached = peekDockerApiPrefix(input.endpointKey);
  if (cached !== undefined) return cached;
  if (input.explicitPrefix !== undefined && input.explicitPrefix !== "") {
    const resolved = resolvedPrefix(input.explicitPrefix, "explicit");
    rememberDockerApiPrefix(input.endpointKey, resolved);
    return resolved;
  }
  const fromEnv = dockerApiPrefixFromEnv(input.env);
  if (fromEnv !== undefined) {
    if (isDockerApiPrefixFailure(fromEnv)) return fromEnv;
    rememberDockerApiPrefix(input.endpointKey, fromEnv);
    return fromEnv;
  }
  return resolvedPrefix(input.preferredPrefix, "preferred");
};

export const learnDockerApiPrefix = (input: {
  readonly endpointKey: string;
  readonly usedPrefix: string;
  readonly usedSource: DockerApiPrefixSource;
  readonly status: number;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body: string;
}): DockerApiPrefixLearnResult => {
  if (input.usedSource === "explicit" || input.usedSource === "env") {
    return { prefix: input.usedPrefix, retry: false };
  }

  const success = input.status >= 200 && input.status < 300;
  if (success && input.usedPrefix !== "") {
    // A 2xx proves this prefix. Keep it even when the daemon advertises a lower
    // ApiVersion (Podman compat) or omits MinAPIVersion on the successful retry.
    rememberDockerApiPrefix(input.endpointKey, resolvedPrefix(input.usedPrefix, "negotiated"));
    return { prefix: input.usedPrefix, retry: false };
  }

  if (!isDockerApiVersionRejection(input.status, input.body)) {
    return { prefix: peekDockerApiPrefix(input.endpointKey)?.prefix ?? input.usedPrefix, retry: false };
  }

  forgetDockerApiPrefix(input.endpointKey);
  const range = extractDockerDaemonApiRange({
    ...(input.headers === undefined ? {} : { headers: input.headers }),
    body: input.body,
  });
  if (range.minApiVersion === undefined) {
    return { prefix: input.usedPrefix, retry: false };
  }

  const negotiation = negotiateDockerApiVersion(range);
  if (!negotiation.ok) return { prefix: input.usedPrefix, retry: false, failure: negotiation };

  const resolved: ResolvedDockerApiPrefix = {
    prefix: negotiation.prefix,
    source: "negotiated",
    version: negotiation.version,
  };
  rememberDockerApiPrefix(input.endpointKey, resolved);
  return {
    prefix: negotiation.prefix,
    retry: negotiation.prefix !== input.usedPrefix,
  };
};

export const preferredPrefixFromVersion = dockerApiPrefixFor;
