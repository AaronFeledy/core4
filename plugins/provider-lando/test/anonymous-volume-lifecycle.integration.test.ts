import { expect, test } from "bun:test";
import { runStorageLifecycle } from "@lando/container-runtime/testing/storage-lifecycle";
import { resolveLiveProviderSocket } from "@lando/engine/testing/live-provider-socket";

const socket = resolveLiveProviderSocket()?.socketPath;
test.skipIf(socket === undefined)(
  `live storage lifetime: Podman${socket === undefined ? " (SKIP: explicit answering LANDO_TEST_PODMAN_SOCKET required)" : ""}`,
  async () => {
    // Given an explicitly selected answering daemon, never the host's managed fallback.
    if (socket === undefined) throw new Error("LANDO_TEST_PODMAN_SOCKET required");
    // When the shared scenario finishes, including fixture-only cleanup.
    const result = await runStorageLifecycle({ provider: "podman", socket });
    // Then every exact-ID and marker assertion succeeded.
    expect(result.outcome).toBe("passed");
    expect(result.cleanup).toBe("completed");
  },
  240_000,
);
