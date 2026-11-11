import { expect, test } from "bun:test";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeLandoPaths } from "@lando/paths";
import { AbsolutePath, ProviderId, appIdentityKey } from "@lando/sdk/schema";
import { Effect } from "effect";
import { serviceCertificatePaths } from "../../src/lifecycle/service-certificate-paths.ts";
import { globalDestroy } from "../../src/operations/global-destroy.ts";
import { globalPlanAt, globalTeardownHarness } from "../../src/testing/global-teardown.ts";

for (const evidence of ["applied", "absent"] as const) {
  for (const scoped of [false, true]) {
    test(`global destroy (${evidence}, scoped=${scoped}) removes leaf certificates only when unscoped`, async () => {
      const root = await realpath(await mkdtemp(join(tmpdir(), "global-destroy-certificates-")));
      try {
        // Given: the global owner's leaf directory, with or without an applied global app.
        const certsDir = makeLandoPaths({
          userDataRoot: root,
          userCacheRoot: join(root, "cache"),
          userConfRoot: join(root, "conf"),
          systemPluginRoot: join(root, "sys"),
          env: {},
          platform: "linux",
        }).certsDir;
        const appRoot = AbsolutePath.make(join(root, "global"));
        const { certPath } = serviceCertificatePaths(certsDir, appIdentityKey("owner", appRoot), "ssh-agent");
        await Bun.write(certPath, "certificate\n");
        const harness = await globalTeardownHarness(
          root,
          evidence === "applied" ? { plan: globalPlanAt(appRoot) } : {},
        );

        // When
        const result = await Effect.runPromise(
          globalDestroy({ yes: true, ...(scoped ? { providerId: ProviderId.make("lando") } : {}) }).pipe(
            Effect.provide(harness.layer),
          ),
        );

        // Then: a provider-scoped destroy keeps material another realization may mount, and the
        // absent path reports unchanged without tearing anything down.
        expect(result.outcome).toBe(evidence === "applied" ? "destroyed" : "unchanged");
        if (evidence === "absent") {
          expect(harness.calls).not.toContain("destroy");
          expect(harness.calls).not.toContain("removeObservedService");
          expect(harness.calls).not.toContain("ensureReady");
        }
        expect(await Bun.file(certPath).exists()).toBe(scoped);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
  }
}
