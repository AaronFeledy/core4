import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";

import { ProviderUnavailableError } from "@lando/sdk/errors";
import { AbsolutePath, appIdentityKey } from "@lando/sdk/schema";
import { globalDestroy } from "../../src/cli/commands/meta/global-destroy.ts";
import { globalStop } from "../../src/cli/commands/meta/global-stop.ts";
import { globalPlanAt, globalTeardownHarness } from "../_support/global-teardown-harness.ts";

const withDataRoot = async (use: (dataRoot: string) => Promise<void>) => {
  const dataRoot = await realpath(await mkdtemp(join(tmpdir(), "lando-global-observation-")));
  try {
    await use(dataRoot);
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
  }
};

for (const command of ["stop", "destroy"] as const) {
  test(`${command} observes a stopped runtime without starting or listing it`, async () => {
    await withDataRoot(async (dataRoot) => {
      // Given an absent global root and isAvailable=true on a stopped managed runtime.
      const harness = await globalTeardownHarness(dataRoot, { status: Effect.succeed({ running: false }) });
      // When teardown has no applied state.
      const result =
        command === "stop"
          ? await Effect.runPromise(globalStop().pipe(Effect.provide(harness.layer)))
          : await Effect.runPromise(globalDestroy({ yes: true }).pipe(Effect.provide(harness.layer)));
      // Then it returns a read-only no-op without materializing the root or parsing desired YAML.
      expect(result.materialized).toBe(false);
      expect(harness.calls).toEqual([]);
      expect(await readdir(dataRoot)).toEqual([]);
    });
  });

  for (const mode of ["applied", "orphans"] as const) {
    test(`${command} tears down ${mode} evidence through a symlinked user data root`, async () => {
      await withDataRoot(async (dataRoot) => {
        // Given canonical-owned resources reached through a real symlink or Windows junction.
        const root = AbsolutePath.make(join(dataRoot, "global"));
        await mkdir(root);
        await writeFile(join(root, ".lando.dist.yml"), "services:\n  broken line\n");
        const alias = join(dataRoot, "alias");
        await symlink(dataRoot, alias, process.platform === "win32" ? "junction" : "dir");
        const plan = globalPlanAt(root);
        const harness = await globalTeardownHarness(
          alias,
          mode === "applied" ? { plan } : { orphanRoot: root },
        );
        // When teardown resolves exact ownership before any desired config read.
        const result =
          command === "stop"
            ? await Effect.runPromise(globalStop().pipe(Effect.provide(harness.layer)))
            : await Effect.runPromise(globalDestroy({ yes: true }).pipe(Effect.provide(harness.layer)));
        // Then evidence removal, event refs, and orphan selection all use canonical ownership.
        expect(result.materialized).toBe(true);
        expect("servicesStopped" in result ? result.servicesStopped : result.servicesDestroyed).toEqual([
          "ssh-agent",
        ]);
        expect(harness.calls).toContain(mode === "applied" ? "destroy" : "removeObservedService");
        if (mode === "applied") {
          expect(harness.destroyed).toEqual([plan]);
          expect(harness.destroyed[0]?.identity).toEqual({
            appRoot: root,
            ownerKey: appIdentityKey("owner", root),
          });
        } else {
          expect(harness.selectedRoots.at(-1)).toBe(root);
        }
        if (command === "stop") expect(harness.eventRoots).toEqual([root, root]);
        expect(harness.calls).not.toContain("ensureReady");
      });
    });
  }
}

const unavailable = new ProviderUnavailableError({
  providerId: "lando",
  operation: "inspect",
  message: "runtime observation unavailable",
});
for (const probe of ["availability", "status"] as const) {
  test(`global teardown treats ${probe} failure as unobserved runtime`, async () => {
    await withDataRoot(async (dataRoot) => {
      const harness = await globalTeardownHarness(dataRoot, { [probe]: Effect.fail(unavailable) });
      await Effect.runPromise(globalStop().pipe(Effect.provide(harness.layer)));
      expect(harness.calls).toEqual([]);
    });
  });
}

test("global teardown preserves applied-state failures even when runtime observation is unavailable", async () => {
  await withDataRoot(async (dataRoot) => {
    const harness = await globalTeardownHarness(dataRoot, {
      status: Effect.succeed({ running: false }),
      appliedPlans: Effect.fail(unavailable),
    });
    const result = await Effect.runPromise(globalStop().pipe(Effect.provide(harness.layer), Effect.result));
    expect(result).toMatchObject({ _tag: "Failure", failure: unavailable });
    expect(harness.calls).toEqual([]);
  });
});

for (const detail of ["owner-key", "canonical-root"] as const) {
  test(`global teardown refuses mismatched ${detail} through a symlinked root`, async () => {
    await withDataRoot(async (dataRoot) => {
      const root = AbsolutePath.make(join(dataRoot, "global"));
      await mkdir(root);
      const alias = join(dataRoot, "alias");
      await symlink(dataRoot, alias, process.platform === "win32" ? "junction" : "dir");
      const aliasRoot = AbsolutePath.make(join(alias, "global"));
      const plan = globalPlanAt(root);
      const invalid =
        detail === "owner-key"
          ? { ...plan, identity: { appRoot: root, ownerKey: appIdentityKey("owner", aliasRoot) } }
          : { ...plan, root: aliasRoot };
      const harness = await globalTeardownHarness(alias, { plan: invalid });
      const result = await Effect.runPromise(globalStop().pipe(Effect.provide(harness.layer), Effect.result));
      expect(result).toMatchObject({ _tag: "Failure", failure: { _tag: "AppResolveError", detail } });
      expect(harness.calls).toEqual([]);
    });
  });
}
