import { readFileSync } from "node:fs";
import { join } from "node:path";
import { normalizeNamedPipePath } from "@lando/container-runtime/transport";
import { sha256Hex } from "@lando/sdk/digest";
import { type HostPlatform, hostPlatformFamily } from "@lando/sdk/schema";
import { Schema } from "effect";

/**
 * Docker host precedence, first match wins:
 * 1. explicit `dockerHost` option
 * 2. `LANDO_TEST_WINDOWS_DOCKER_SOCKET` (win32) then `LANDO_TEST_DOCKER_SOCKET`
 * 3. `DOCKER_HOST`
 * 4. `LANDO_DOCKER_DESKTOP` (Linux-family Desktop socket)
 * 5. Docker CLI context (`DOCKER_CONTEXT`, else `currentContext`)
 * 6. platform default (`npipe://./pipe/docker_engine` on win32, else `/var/run/docker.sock`)
 */
export const DOCKER_HOST_PRECEDENCE = [
  "option",
  "LANDO_TEST_* sockets",
  "DOCKER_HOST",
  "LANDO_DOCKER_DESKTOP",
  "Docker context",
  "platform default",
] as const;

export const DEFAULT_UNIX_DOCKER_HOST = "/var/run/docker.sock";
export const DEFAULT_WINDOWS_DOCKER_HOST = "npipe://./pipe/docker_engine";

export type DockerContextFileReader = (path: string) => string | undefined;

export type DockerHostSource =
  | { readonly kind: "option" }
  | { readonly kind: "LANDO_TEST_WINDOWS_DOCKER_SOCKET" }
  | { readonly kind: "LANDO_TEST_DOCKER_SOCKET" }
  | { readonly kind: "DOCKER_HOST" }
  | { readonly kind: "LANDO_DOCKER_DESKTOP" }
  | { readonly kind: "context"; readonly name: string }
  | { readonly kind: "default" };

export interface ResolvedDockerHost {
  readonly host: string;
  readonly source: DockerHostSource;
}

export type UnsupportedDockerContextReason =
  | "tls"
  | "missing-endpoint"
  | "unusable-endpoint"
  | "missing-meta"
  | "invalid-meta";

export class UnsupportedDockerContextError extends Schema.TaggedError<UnsupportedDockerContextError>()(
  "UnsupportedDockerContextError",
  {
    contextName: Schema.String,
    reason: Schema.Literals(["tls", "missing-endpoint", "unusable-endpoint", "missing-meta", "invalid-meta"]),
    message: Schema.String,
    remediation: Schema.NonEmptyString.check(Schema.isPattern(/\S/u)),
  },
) {}

export type DockerHostResolution =
  | { readonly ok: true; readonly host: string; readonly source: DockerHostSource }
  | { readonly ok: false; readonly error: UnsupportedDockerContextError };

export interface ResolveDockerHostDetailsOptions {
  readonly dockerHost?: string;
  readonly platform: HostPlatform;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly readFile?: DockerContextFileReader;
}

export const readDockerContextFile: DockerContextFileReader = (path) => {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
};

export const dockerConfigDirFromEnv = (
  env: Readonly<Record<string, string | undefined>>,
): string | undefined => {
  if (env.DOCKER_CONFIG !== undefined && env.DOCKER_CONFIG.length > 0) return env.DOCKER_CONFIG;
  const home = env.HOME ?? env.USERPROFILE;
  return home === undefined || home.length === 0 ? undefined : join(home, ".docker");
};

export const dockerContextMetaPath = (dockerConfigDir: string, contextName: string): string =>
  join(dockerConfigDir, "contexts", "meta", sha256Hex(contextName), "meta.json");

export const dockerHostSourceLabel = (source: DockerHostSource): string =>
  source.kind === "context" ? `context ${source.name}` : source.kind;

const resolved = (host: string, source: DockerHostSource): DockerHostResolution => ({
  ok: true,
  host,
  source,
});

const unsupportedMessage = (contextName: string, reason: UnsupportedDockerContextReason): string => {
  switch (reason) {
    case "tls":
      return `Docker context "${contextName}" uses TLS, which the docker provider does not support.`;
    case "missing-meta":
      return `Docker context "${contextName}" metadata was not found.`;
    case "invalid-meta":
      return `Docker context "${contextName}" metadata is invalid.`;
    case "missing-endpoint":
      return `Docker context "${contextName}" has no Docker endpoint.`;
    case "unusable-endpoint":
      return `Docker context "${contextName}" endpoint is not a local socket or TCP host.`;
  }
};

export const unsupportedDockerContext = (
  contextName: string,
  reason: UnsupportedDockerContextReason,
): UnsupportedDockerContextError =>
  new UnsupportedDockerContextError({
    contextName,
    reason,
    message: unsupportedMessage(contextName, reason),
    remediation:
      "Use a Docker context without TLS whose endpoint is a local socket or TCP host, or set DOCKER_HOST to that endpoint, then retry. Run `lando doctor --provider=docker` to inspect the Docker provider.",
  });

const objectRecord = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

const contextNameFromEnv = (env: Readonly<Record<string, string | undefined>>): string | undefined => {
  const name = env.DOCKER_CONTEXT?.trim();
  return name === undefined || name.length === 0 ? undefined : name;
};

const currentContextFromConfig = (
  configDir: string,
  readFile: DockerContextFileReader,
): string | undefined => {
  const raw = readFile(join(configDir, "config.json"));
  if (raw === undefined) return undefined;
  try {
    const currentContext = objectRecord(JSON.parse(raw) as unknown)?.currentContext;
    return typeof currentContext === "string" && currentContext.trim().length > 0
      ? currentContext.trim()
      : undefined;
  } catch {
    return undefined;
  }
};

const hasTlsMaterial = (value: unknown): boolean => {
  const material = objectRecord(value);
  return material !== undefined && Object.keys(material).length > 0;
};

const isUsableDockerEndpoint = (host: string): boolean =>
  host.startsWith("unix://") ||
  host.startsWith("npipe:") ||
  host.startsWith("\\\\.\\pipe\\") ||
  host.startsWith("tcp://") ||
  host.startsWith("http://") ||
  host.startsWith("https://") ||
  host.startsWith("/");

/** Canonicalize npipe Host values to the same `npipe://./pipe/...` form as the win32 default. */
export const normalizeDockerContextHost = (host: string): string => {
  if (!host.startsWith("npipe:") && !host.startsWith("\\\\.\\pipe\\")) return host;
  const windowsPath = normalizeNamedPipePath(host.startsWith("npipe:") ? host : `npipe:${host}`);
  const pipePrefix = "\\\\.\\pipe\\";
  if (!windowsPath.startsWith(pipePrefix)) return host;
  return `npipe://./pipe/${windowsPath.slice(pipePrefix.length).replaceAll("\\", "/")}`;
};

const readNamedDockerContext = (
  contextName: string,
  configDir: string | undefined,
  readFile: DockerContextFileReader,
): DockerHostResolution => {
  if (configDir === undefined) {
    return { ok: false, error: unsupportedDockerContext(contextName, "missing-meta") };
  }
  const raw = readFile(dockerContextMetaPath(configDir, contextName));
  if (raw === undefined) {
    return { ok: false, error: unsupportedDockerContext(contextName, "missing-meta") };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return { ok: false, error: unsupportedDockerContext(contextName, "invalid-meta") };
  }
  const meta = objectRecord(parsed);
  if (meta === undefined) {
    return { ok: false, error: unsupportedDockerContext(contextName, "invalid-meta") };
  }
  if (hasTlsMaterial(meta.TLSMaterial)) {
    return { ok: false, error: unsupportedDockerContext(contextName, "tls") };
  }
  const endpoint = objectRecord(objectRecord(meta.Endpoints)?.docker);
  if (endpoint === undefined) {
    return { ok: false, error: unsupportedDockerContext(contextName, "missing-endpoint") };
  }
  if (endpoint.SkipTLSVerify === true) {
    return { ok: false, error: unsupportedDockerContext(contextName, "tls") };
  }
  const host = typeof endpoint.Host === "string" ? endpoint.Host.trim() : "";
  if (host.length === 0) {
    return { ok: false, error: unsupportedDockerContext(contextName, "missing-endpoint") };
  }
  if (!isUsableDockerEndpoint(host)) {
    return { ok: false, error: unsupportedDockerContext(contextName, "unusable-endpoint") };
  }
  return resolved(normalizeDockerContextHost(host), { kind: "context", name: contextName });
};

export const resolveDockerHostDetails = (options: ResolveDockerHostDetailsOptions): DockerHostResolution => {
  const env = options.env ?? {};
  const readFile = options.readFile ?? readDockerContextFile;
  if (options.dockerHost !== undefined) return resolved(options.dockerHost, { kind: "option" });

  const family = hostPlatformFamily(options.platform);
  if (family === "win32" && env.LANDO_TEST_WINDOWS_DOCKER_SOCKET !== undefined) {
    return resolved(env.LANDO_TEST_WINDOWS_DOCKER_SOCKET, { kind: "LANDO_TEST_WINDOWS_DOCKER_SOCKET" });
  }
  if (env.LANDO_TEST_DOCKER_SOCKET !== undefined) {
    return resolved(env.LANDO_TEST_DOCKER_SOCKET, { kind: "LANDO_TEST_DOCKER_SOCKET" });
  }
  if (env.DOCKER_HOST !== undefined) return resolved(env.DOCKER_HOST, { kind: "DOCKER_HOST" });
  if (family === "linux" && env.HOME !== undefined && env.LANDO_DOCKER_DESKTOP === "1") {
    return resolved(`${env.HOME}/.docker/desktop/docker.sock`, { kind: "LANDO_DOCKER_DESKTOP" });
  }

  const configDir = dockerConfigDirFromEnv(env);
  const contextName =
    contextNameFromEnv(env) ??
    (configDir === undefined ? undefined : currentContextFromConfig(configDir, readFile));
  if (contextName !== undefined && contextName !== "default") {
    return readNamedDockerContext(contextName, configDir, readFile);
  }

  if (family === "win32") return resolved(DEFAULT_WINDOWS_DOCKER_HOST, { kind: "default" });
  return resolved(DEFAULT_UNIX_DOCKER_HOST, { kind: "default" });
};
