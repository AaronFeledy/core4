import { chmod, copyFile, mkdir, stat } from "node:fs/promises";
import { basename } from "node:path";
import { dirname } from "node:path";
import { Effect } from "effect";

import { HostProxyTransportUnavailableError } from "@lando/sdk/errors";

export const HOST_PROXY_SHIM_SOURCE = "core/src/subsystems/host-proxy/shim-bin.ts";
export const HOST_PROXY_SHIM_ARTIFACT_ENV = "LANDO_HOST_PROXY_SHIM_ARTIFACT";
export const HOST_PROXY_SHIM_ARTIFACT = "core/dist/host-proxy/lando-shim";

export const defaultHostProxyShimArtifactPath = (
  input: {
    readonly env?: Readonly<Record<string, string | undefined>>;
    readonly execPath?: string;
  } = {},
): string => {
  const env = input.env ?? process.env;
  const configured = env[HOST_PROXY_SHIM_ARTIFACT_ENV];
  if (configured !== undefined && configured.length > 0) return configured;
  const execPath = input.execPath ?? process.execPath;
  const execName = basename(execPath).toLowerCase();
  if (execName !== "bun" && execName !== "bun.exe") return execPath;
  return new URL("../../../dist/host-proxy/lando-shim", import.meta.url).pathname;
};

export const installHostProxyShim = (
  artifact: string,
  output: string,
): Effect.Effect<void, HostProxyTransportUnavailableError> =>
  Effect.tryPromise({
    try: async () => {
      await mkdir(dirname(output), { recursive: true });
      await stat(artifact);
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
