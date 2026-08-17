import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { teardownManagedProviderMachine } from "../../src/runtime/managed-provider-machine.ts";

// Env-gated live provider integration: exercises real `podman machine rm --force lando`.
// Opt in with LANDO_TEST_PODMAN_MACHINE_TEARDOWN=1 on a host where destroying a "lando"
// Podman machine is acceptable. Skipped by default so the normal suite never spawns podman.
const liveEnabled = process.env.LANDO_TEST_PODMAN_MACHINE_TEARDOWN === "1";

describe("teardownManagedProviderMachine (live podman)", () => {
  test.skipIf(!liveEnabled)("removing an owned machine converges on repeated runs", async () => {
    const root = mkdtempSync(join(tmpdir(), "lando-machine-live-"));
    const dir = join(root, "providers", "provider-lando");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "setup-state.json"),
      JSON.stringify({ podmanVersion: "live", machine: { name: "lando", createdByLando: true } }),
      "utf-8",
    );
    try {
      const first = await teardownManagedProviderMachine(root);
      expect(typeof first.removed).toBe("boolean");

      const second = await teardownManagedProviderMachine(root);
      expect(second.removed).toBe(false);
      expect(second.name).toBe("lando");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
