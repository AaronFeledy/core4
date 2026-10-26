import { expect, test } from "bun:test";
import { runStorageLifecycle } from "@lando/container-runtime/testing/storage-lifecycle";

const socket = process.env.LANDO_TEST_DOCKER_SOCKET || undefined;
test.skipIf(socket === undefined)(
  `live storage lifetime: Docker${socket === undefined ? " (SKIP: explicit LANDO_TEST_DOCKER_SOCKET required)" : ""}`,
  async () => {
    // Given an explicitly selected daemon; the driver probes its API before acquiring anything.
    if (socket === undefined) throw new Error("LANDO_TEST_DOCKER_SOCKET required");
    // When the shared scenario finishes, including fixture-only cleanup.
    const result = await runStorageLifecycle({ provider: "docker", socket });
    // Then every exact-ID and marker assertion succeeded.
    expect(result.outcome).toBe("passed");
    expect(result.cleanup).toBe("completed");
  },
  240_000,
);
