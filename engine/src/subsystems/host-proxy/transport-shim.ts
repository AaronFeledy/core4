import { constants } from "node:fs";
import { chmod, copyFile, mkdir, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { Effect } from "effect";

import { HostProxyTransportUnavailableError, causeMessage } from "@lando/sdk/errors";
import type { HostProxyContainerTarget } from "@lando/sdk/schema";

export type HostProxyShimTarget = HostProxyContainerTarget;

/**
 * Copies the resolved container helper to the session's mount source. The copy
 * lands under a temporary name first, so a running container never sees a
 * partially written file and a busy executable is replaced, not rewritten.
 */
export const installHostProxyShim = (
  artifact: string,
  output: string,
): Effect.Effect<void, HostProxyTransportUnavailableError> =>
  Effect.tryPromise({
    try: async () => {
      await mkdir(dirname(output), { recursive: true });
      const staging = `${output}.lando-stage.${process.pid}`;
      try {
        await copyFile(artifact, staging, constants.COPYFILE_FICLONE);
        await chmod(staging, 0o755);
        await rename(staging, output);
      } finally {
        await rm(staging, { force: true });
      }
    },
    catch: (cause) =>
      new HostProxyTransportUnavailableError({
        message: causeMessage(cause),
        socketPath: artifact,
        remediation: "Check that the Lando data directory is writable, then retry.",
      }),
  });
