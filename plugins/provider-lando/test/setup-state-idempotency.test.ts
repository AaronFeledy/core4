import { expect, test } from "bun:test";
import { chmod, mkdtemp, rm, stat, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sha256Hex } from "@lando/sdk/digest";
import { Effect } from "effect";
import { persistSetupState, providerStatePath, setupProviderLando } from "../src/setup.ts";

test.each(["matching", "mode-only"] as const)(
  "setup state skips content writes for %s state",
  async (condition) => {
    const root = await mkdtemp(join(tmpdir(), "lando-setup-state-idempotency-"));
    try {
      const state = { podmanVersion: "6.0.1", runtimeBundleVersion: "0.1.7" };
      const path = await Effect.runPromise(persistSetupState(root, state));
      await utimes(path, 1, 1);
      if (condition === "mode-only") await chmod(path, 0o644);
      const before = (await stat(path)).mtimeMs;
      await Effect.runPromise(
        persistSetupState(root, state, async () => {
          throw new Error("unchanged state must not be rewritten");
        }),
      );
      expect((await stat(path)).mtimeMs).toBe(before);
      expect((await stat(path)).mode & 0o7777).toBe(0o600);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

test("setup holds one runtime lock across bundle preparation, readiness, and state commit", async () => {
  const root = await mkdtemp(join(tmpdir(), "lando-setup-lock-"));
  let locked = false;
  let acquisitions = 0;
  const bytes = new TextEncoder().encode("verified-bundle-fixture");
  try {
    await Effect.runPromise(
      setupProviderLando({
        platform: "linux",
        skipSocketProbe: true,
        stateDir: root,
        runtimeBundleDownloader: {
          download: Effect.sync(() => {
            expect(locked).toBe(true);
            return { version: "0.1.7", bytes, sha256: sha256Hex(bytes) };
          }),
        },
        podmanCommand: {
          version: Effect.sync(() => {
            expect(locked).toBe(true);
            return "podman version 6.0.1";
          }),
        },
        managedRuntimeSetup: () =>
          Effect.sync(() => {
            expect(locked).toBe(true);
          }),
        withRuntimeLock: (body) =>
          Effect.acquireUseRelease(
            Effect.sync(() => {
              expect(locked).toBe(false);
              locked = true;
              acquisitions++;
            }),
            () => body,
            () =>
              Effect.promise(async () => {
                expect((await stat(providerStatePath(root))).isFile()).toBe(true);
                locked = false;
              }),
          ),
      }),
    );
    expect(acquisitions).toBe(1);
    expect(locked).toBe(false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
