import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { normalizeNamedPipePath } from "@lando/container-runtime/transport";
import { sha256Hex } from "@lando/sdk/digest";
import { type HostPlatform, hostPlatformFamily } from "@lando/sdk/schema";
import { Result, Schema } from "effect";

type Env = Readonly<Record<string, string | undefined>>;

export type DockerEndpointSource =
  | { readonly kind: "option" }
  | { readonly kind: "LANDO_TEST_WINDOWS_DOCKER_SOCKET" }
  | { readonly kind: "LANDO_TEST_DOCKER_SOCKET" }
  | { readonly kind: "DOCKER_HOST" }
  | { readonly kind: "LANDO_DOCKER_DESKTOP" }
  | { readonly kind: "context"; readonly name: string }
  | { readonly kind: "default" };

export interface DockerEndpoint {
  readonly host: string;
  readonly source: DockerEndpointSource;
}

const UnsupportedDockerContextReason = Schema.Literals([
  "not-found",
  "invalid-metadata",
  "no-docker-endpoint",
  "unsupported-endpoint",
  "tls",
]);
type UnsupportedDockerContextReason = typeof UnsupportedDockerContextReason.Type;

export class UnsupportedDockerContextError extends Schema.TaggedError<UnsupportedDockerContextError>()(
  "UnsupportedDockerContextError",
  {
    contextName: Schema.String,
    reason: UnsupportedDockerContextReason,
    message: Schema.String,
    remediation: Schema.NonEmptyString.check(Schema.isPattern(/\S/u)),
  },
) {}

interface SelectedContext {
  readonly name: string;
  readonly selectedBy: "DOCKER_CONTEXT" | "config";
}

export interface ResolveDockerHostOptions {
  readonly platform: HostPlatform;
  readonly env: Env;
  readonly dockerHost?: string;
}

// The Docker CLI treats an empty variable as unset.
const nonEmpty = (value: string | undefined): string | undefined => {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed.length === 0 ? undefined : trimmed;
};

const readText = (path: string): string | undefined => {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
};

const DockerConfigFile = Schema.fromJsonString(
  Schema.Struct({ currentContext: Schema.optional(Schema.String) }),
);

const ContextMetadata = Schema.fromJsonString(
  Schema.Struct({
    Endpoints: Schema.optional(
      Schema.Struct({
        docker: Schema.optional(
          Schema.Struct({
            Host: Schema.optional(Schema.String),
            SkipTLSVerify: Schema.optional(Schema.Boolean),
          }),
        ),
      }),
    ),
  }),
);

/** `DOCKER_CONFIG`, else `.docker` under the home directory Go's `os.UserHomeDir` reports. */
const dockerConfigDir = (platform: HostPlatform, env: Env): string | undefined => {
  const explicit = nonEmpty(env.DOCKER_CONFIG);
  if (explicit !== undefined) return explicit;
  const home = nonEmpty(hostPlatformFamily(platform) === "win32" ? env.USERPROFILE : env.HOME);
  return home === undefined ? undefined : join(home, ".docker");
};

const selectedContext = (configDir: string | undefined, env: Env): SelectedContext | undefined => {
  const fromEnv = nonEmpty(env.DOCKER_CONTEXT);
  if (fromEnv !== undefined) return { name: fromEnv, selectedBy: "DOCKER_CONTEXT" };
  if (configDir === undefined) return undefined;
  const raw = readText(join(configDir, "config.json"));
  // The Docker CLI warns about an unreadable config.json and continues without a context.
  const config =
    raw === undefined ? undefined : Result.getOrUndefined(Schema.decodeUnknownResult(DockerConfigFile)(raw));
  const name = nonEmpty(config?.currentContext);
  return name === undefined ? undefined : { name, selectedBy: "config" };
};

const isSocketHost = (host: string): boolean => host.startsWith("unix://") || host.startsWith("npipe://");

const PIPE_PREFIX = "\\\\.\\pipe\\";

/**
 * One spelling per socket, because the endpoint keys volume coordination: a path is `unix://<path>`,
 * the spelling the Podman providers use for the same key, and Docker's `npipe:////./pipe/<name>` and
 * `\\.\pipe\<name>` are Lando's `npipe://./pipe/<name>`.
 */
const canonicalHost = (host: string): string => {
  if (host.startsWith("/")) return `unix://${host}`;
  const windowsPath = host.startsWith("npipe:") ? normalizeNamedPipePath(host) : host;
  return windowsPath.startsWith(PIPE_PREFIX)
    ? `npipe://./pipe/${windowsPath.slice(PIPE_PREFIX.length).replaceAll("\\", "/")}`
    : host;
};

const unsupportedMessage = (name: string, reason: UnsupportedDockerContextReason, host: string): string => {
  switch (reason) {
    case "not-found":
      return `Docker context "${name}" was not found.`;
    case "invalid-metadata":
      return `Docker context "${name}" has unreadable metadata.`;
    case "no-docker-endpoint":
      return `Docker context "${name}" has no Docker endpoint.`;
    case "unsupported-endpoint": {
      // Only the scheme: the rest of the host can carry credentials.
      const scheme = /^([a-z][a-z0-9+.-]*):\/\//iu.exec(host)?.[1];
      return scheme === undefined
        ? `Docker context "${name}" has an endpoint the docker provider cannot parse.`
        : `Docker context "${name}" uses the ${scheme}:// scheme, which the docker provider cannot connect to.`;
    }
    case "tls":
      return `Docker context "${name}" connects over TLS, which the docker provider does not support.`;
  }
};

const unsupportedContext = (
  context: SelectedContext,
  reason: UnsupportedDockerContextReason,
  host = "",
): UnsupportedDockerContextError => {
  const select =
    context.selectedBy === "DOCKER_CONTEXT"
      ? "Unset DOCKER_CONTEXT or point it at a context whose endpoint is a local socket or plain TCP host"
      : "Run `docker context use <name>` for a context whose endpoint is a local socket or plain TCP host";
  return new UnsupportedDockerContextError({
    contextName: context.name,
    reason,
    message: unsupportedMessage(context.name, reason, host),
    remediation: `${select}, or set DOCKER_HOST to the engine socket, then retry. \`docker context ls\` lists the contexts.`,
  });
};

const readContextEndpoint = (
  context: SelectedContext,
  configDir: string | undefined,
): Result.Result<DockerEndpoint, UnsupportedDockerContextError> => {
  if (configDir === undefined) return Result.fail(unsupportedContext(context, "not-found"));
  const digest = sha256Hex(context.name);
  const raw = readText(join(configDir, "contexts", "meta", digest, "meta.json"));
  if (raw === undefined) return Result.fail(unsupportedContext(context, "not-found"));
  const meta = Schema.decodeUnknownResult(ContextMetadata)(raw);
  if (Result.isFailure(meta)) return Result.fail(unsupportedContext(context, "invalid-metadata"));
  const endpoint = meta.success.Endpoints?.docker;
  const host = nonEmpty(endpoint?.Host);
  if (endpoint === undefined || host === undefined) {
    return Result.fail(unsupportedContext(context, "no-docker-endpoint"));
  }
  const source = { kind: "context", name: context.name } as const;
  if (isSocketHost(host)) return Result.succeed({ host: canonicalHost(host), source });
  if (host.startsWith("https://")) return Result.fail(unsupportedContext(context, "tls", host));
  if (!host.startsWith("tcp://") && !host.startsWith("http://")) {
    return Result.fail(unsupportedContext(context, "unsupported-endpoint", host));
  }
  // TLS files live beside the metadata store, never in meta.json, and apply only to TCP endpoints.
  const tlsDir = join(configDir, "contexts", "tls", digest, "docker");
  const usesTls =
    endpoint.SkipTLSVerify === true ||
    ["ca.pem", "cert.pem", "key.pem"].some((file) => existsSync(join(tlsDir, file)));
  if (usesTls) return Result.fail(unsupportedContext(context, "tls", host));
  return Result.succeed({ host, source });
};

/**
 * First match wins: explicit option, `LANDO_TEST_*` sockets, `DOCKER_HOST`, `LANDO_DOCKER_DESKTOP`,
 * the Docker CLI context (`DOCKER_CONTEXT`, else `currentContext` in `config.json`), then the
 * platform default. The reserved `default` context means the platform default, as in the Docker CLI.
 */
export const resolveDockerHost = (
  options: ResolveDockerHostOptions,
): Result.Result<DockerEndpoint, UnsupportedDockerContextError> => {
  const { env, platform } = options;
  const resolved = (host: string, source: DockerEndpointSource) =>
    Result.succeed({ host: canonicalHost(host), source });
  if (options.dockerHost !== undefined) return resolved(options.dockerHost, { kind: "option" });
  const family = hostPlatformFamily(platform);
  const windowsTestSocket = nonEmpty(env.LANDO_TEST_WINDOWS_DOCKER_SOCKET);
  if (family === "win32" && windowsTestSocket !== undefined) {
    return resolved(windowsTestSocket, { kind: "LANDO_TEST_WINDOWS_DOCKER_SOCKET" });
  }
  const testSocket = nonEmpty(env.LANDO_TEST_DOCKER_SOCKET);
  if (testSocket !== undefined) return resolved(testSocket, { kind: "LANDO_TEST_DOCKER_SOCKET" });
  const dockerHost = nonEmpty(env.DOCKER_HOST);
  if (dockerHost !== undefined) return resolved(dockerHost, { kind: "DOCKER_HOST" });
  const home = nonEmpty(env.HOME);
  if (family === "linux" && home !== undefined && env.LANDO_DOCKER_DESKTOP === "1") {
    return resolved(`${home}/.docker/desktop/docker.sock`, { kind: "LANDO_DOCKER_DESKTOP" });
  }
  const configDir = dockerConfigDir(platform, env);
  const context = selectedContext(configDir, env);
  if (context !== undefined && context.name !== "default") return readContextEndpoint(context, configDir);
  return family === "win32"
    ? resolved("npipe://./pipe/docker_engine", { kind: "default" })
    : resolved("/var/run/docker.sock", { kind: "default" });
};
