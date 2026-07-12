import { chmod, copyFile, mkdir } from "node:fs/promises";
import { basename, dirname } from "node:path";
import { Effect } from "effect";

import { HostProxyTransportUnavailableError } from "@lando/sdk/errors";
import type { HostProxyContainerTarget } from "@lando/sdk/schema";

export const HOST_PROXY_SHIM_SOURCE = "core/src/subsystems/host-proxy/shim-bin.ts";
export const HOST_PROXY_SHIM_ARTIFACT_ENV = "LANDO_HOST_PROXY_SHIM_ARTIFACT";
export const HOST_PROXY_SHIM_DIST_ROOT_ENV = "LANDO_HOST_PROXY_SHIM_DIST_ROOT";
export const HOST_PROXY_SHIM_ARTIFACT = "core/dist/host-proxy/lando-shim";

export type HostProxyShimTarget = HostProxyContainerTarget;

export const resolveHostProxyShimArtifactPath = (input: {
  readonly distRoot: string;
  readonly target: HostProxyShimTarget;
}): string => `${input.distRoot}/host-proxy/${input.target.os}-${input.target.arch}/lando-shim`;

const defaultDistRoot = (execPath: string): string => {
  const execName = basename(execPath).toLowerCase();
  if (execName === "bun" || execName === "bun.exe") return new URL("../../../dist", import.meta.url).pathname;
  return dirname(execPath);
};

export const defaultHostProxyShimArtifactPath = (
  input: {
    readonly env?: Readonly<Record<string, string | undefined>>;
    readonly execPath?: string;
    readonly target?: HostProxyShimTarget;
    readonly distRoot?: string;
  } = {},
): string => {
  const env = input.env ?? process.env;
  const configured = env[HOST_PROXY_SHIM_ARTIFACT_ENV];
  if (configured !== undefined && configured.length > 0) return configured;
  if (input.target === undefined) {
    throw new Error("Host-proxy shim artifact resolution requires an explicit container target.");
  }
  const execPath = input.execPath ?? process.execPath;
  const configuredDistRoot = env[HOST_PROXY_SHIM_DIST_ROOT_ENV];
  return resolveHostProxyShimArtifactPath({
    distRoot:
      input.distRoot ??
      (configuredDistRoot !== undefined && configuredDistRoot.length > 0
        ? configuredDistRoot
        : defaultDistRoot(execPath)),
    target: input.target,
  });
};

export const installHostProxyShim = (
  artifact: string,
  output: string,
): Effect.Effect<void, HostProxyTransportUnavailableError> =>
  Effect.tryPromise({
    try: async () => {
      await mkdir(dirname(output), { recursive: true });
      await copyFile(artifact, output);
      await chmod(output, 0o755);
    },
    catch: (cause) =>
      new HostProxyTransportUnavailableError({
        message: cause instanceof Error ? cause.message : String(cause),
        socketPath: artifact,
        remediation:
          "Run `bun run --filter='@lando/core' build:host-proxy-shim` before starting apps that use host-proxy runLando.",
      }),
  });
