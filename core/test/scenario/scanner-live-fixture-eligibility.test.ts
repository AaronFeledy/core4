import { afterEach, describe, expect, test } from "bun:test";
import { unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { isScannerLiveEligible, managedProviderSocketPath } from "./scanner-live-fixture.ts";

const ENV_KEY = "LANDO_TEST_PODMAN_SOCKET";
const originalEnv = process.env[ENV_KEY];
let liveSocketServer: ReturnType<typeof Bun.listen> | undefined;
let liveSocketPath: string | undefined;

const restoreEnv = (): void => {
  if (originalEnv === undefined) delete process.env[ENV_KEY];
  else process.env[ENV_KEY] = originalEnv;
  if (liveSocketServer !== undefined) {
    liveSocketServer.stop(true);
    liveSocketServer = undefined;
  }
  if (liveSocketPath !== undefined) {
    try {
      unlinkSync(liveSocketPath);
    } catch {
      // already removed
    }
    liveSocketPath = undefined;
  }
};

const bindMismatchedLiveSocket = (): string => {
  liveSocketPath = join(tmpdir(), `scanner-live-eligibility-${crypto.randomUUID().slice(0, 8)}.sock`);
  liveSocketServer = Bun.listen({ unix: liveSocketPath, socket: { data() {} } });
  return liveSocketPath;
};

describe("scanner live fixture eligibility (host-safe, no runtime connections)", () => {
  afterEach(restoreEnv);

  test("skips when LANDO_TEST_PODMAN_SOCKET is unset, even if the managed socket happens to be live", () => {
    // Given: no explicit opt-in env var.
    delete process.env[ENV_KEY];
    // When: eligibility is evaluated.
    const eligible = isScannerLiveEligible();
    // Then: eligibility is false regardless of the managed socket's real state.
    expect(eligible).toBe(false);
  });

  test("skips when LANDO_TEST_PODMAN_SOCKET is an empty string", () => {
    // Given: an explicitly empty override.
    process.env[ENV_KEY] = "";
    // When: eligibility is evaluated.
    const eligible = isScannerLiveEligible();
    // Then: an empty string is treated as unset, not a live opt-in.
    expect(eligible).toBe(false);
  });

  test("skips when LANDO_TEST_PODMAN_SOCKET names a real live socket at a mismatched path", () => {
    // Given: a genuinely live socket that is NOT the managed provider path.
    const mismatchedSocketPath = bindMismatchedLiveSocket();
    expect(mismatchedSocketPath).not.toBe(managedProviderSocketPath);
    process.env[ENV_KEY] = mismatchedSocketPath;
    // When: eligibility is evaluated.
    const eligible = isScannerLiveEligible();
    // Then: a live-but-wrong socket never enables the fixture.
    expect(eligible).toBe(false);
  });
});
