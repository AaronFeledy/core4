import { expect, test } from "bun:test";
import { runNativeInit } from "@lando/container-runtime/testing/native-init";
import {
  LANDO_TEST_PODMAN_SOCKET_ENV,
  resolveLiveProviderSocket,
} from "@lando/engine/testing/live-provider-socket";

/**
 * Linux entry for the durable native-init fixture.
 * Requires an explicitly answering LANDO_TEST_PODMAN_SOCKET — never the managed fallback.
 * Opted-in missing prerequisites: skip when unset/unanswering; never report PASS with zero cases.
 */
const resolved = resolveLiveProviderSocket();
const socket = resolved?.socketPath;
const optedInMissing =
  process.env[LANDO_TEST_PODMAN_SOCKET_ENV] !== undefined &&
  process.env[LANDO_TEST_PODMAN_SOCKET_ENV] !== "" &&
  socket === undefined;

test.skipIf(socket === undefined && !optedInMissing)(
  `live native-init: Podman${
    socket === undefined
      ? optedInMissing
        ? ` (FAIL gate: ${LANDO_TEST_PODMAN_SOCKET_ENV} set but not answering)`
        : ` (SKIP: explicit answering ${LANDO_TEST_PODMAN_SOCKET_ENV} required)`
      : ""
  }`,
  async () => {
    if (optedInMissing) {
      throw new Error(
        `${LANDO_TEST_PODMAN_SOCKET_ENV} is set but does not answer; native-init refuses a silent pass`,
      );
    }
    if (socket === undefined) throw new Error(`${LANDO_TEST_PODMAN_SOCKET_ENV} required`);

    const result = await runNativeInit({
      transport: { kind: "api", provider: "podman", endpoint: socket },
    });
    console.info("NATIVE_INIT_EVIDENCE", JSON.stringify(result));

    expect(result.cases.length).toBeGreaterThan(0);
    expect(result.outcome).toBe("passed");
    expect(result.cleanup).toBe("completed");
    expect(result.cases.map((entry) => entry.id)).toEqual([
      "direct-term",
      "handler-marker",
      "orphan-reaping",
      "init-false",
      "compose-omitted",
      "nonforwarding-wrapper",
    ]);
  },
  300_000,
);
