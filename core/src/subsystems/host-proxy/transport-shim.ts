import { chmod, copyFile, mkdir, stat } from "node:fs/promises";
import { dirname } from "node:path";
import { Effect } from "effect";

import { HostProxyTransportUnavailableError } from "@lando/sdk/errors";

export const HOST_PROXY_SHIM_SOURCE = "core/src/subsystems/host-proxy/shim-bin.ts";
export const HOST_PROXY_SHIM_ARTIFACT_ENV = "LANDO_HOST_PROXY_SHIM_ARTIFACT";
export const HOST_PROXY_SHIM_ARTIFACT = "core/dist/host-proxy/lando-shim";

export const defaultHostProxyShimArtifactPath = (): string =>
  process.env[HOST_PROXY_SHIM_ARTIFACT_ENV] ??
  new URL("../../../dist/host-proxy/lando-shim", import.meta.url).pathname;

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
