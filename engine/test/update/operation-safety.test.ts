import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProcessRunner, Telemetry } from "@lando/sdk/services";
import { Effect } from "effect";
import { type UpdateOptions, update } from "../../src/update/operation";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
const run = (options: UpdateOptions) =>
  Effect.runPromise(
    update(options).pipe(
      Effect.provideService(Telemetry, { enabled: false, record: () => Effect.void }),
      Effect.provideService(ProcessRunner, {
        run: () => Effect.succeed({ exitCode: 0, stdout: "", stderr: "" }),
        stream: () => {
          throw new Error("unused stream");
        },
      }),
    ),
  );
const fixture = async (): Promise<UpdateOptions> => {
  const root = await mkdtemp(join(tmpdir(), "lando-core-safety-"));
  roots.push(root);
  const binary = { url: "https://fixture.invalid/lando", sha256: "a".repeat(64), size: 1 };
  const manifest = {
    channel: "stable",
    latest: "4.2.0",
    released: "2026-06-17T00:00:00Z",
    minimum: "4.0.0",
    binaries: {
      "linux-x64": binary,
      "linux-arm64": binary,
      "darwin-x64": binary,
      "darwin-arm64": binary,
      "windows-x64": binary,
    },
    checksums: {
      url: "https://fixture.invalid/SHA256SUMS",
      signature: "https://fixture.invalid/SHA256SUMS.sig",
    },
    notes: "https://fixture.invalid/notes",
  };
  return {
    currentVersion: "4.1.0",
    selfUpdate: false,
    updateStatePath: join(root, "state.json"),
    fetchManifestBytes: async () => new TextEncoder().encode(JSON.stringify(manifest)),
    verifyManifestSignature: () => Effect.void,
  };
};

test.each([false, true])("core-only retains plugin safety validation (dryRun=%s)", async (dryRun) => {
  // Given: installed plugins cannot support the proposed core.
  const options = await fixture();
  let validated = false;
  // When: only the core is selected.
  const result = await run({
    ...options,
    only: "core",
    dryRun,
    runPluginUpdates: (input) => {
      validated = true;
      expect(input.combined).toBe(true);
      expect(input.upgradePlugins).toBe(false);
      return Effect.succeed({ rows: [], updatedPlugins: [], blockCore: true, hasFailures: true });
    },
  });
  // Then: compatibility blocks the core without upgrading plugins.
  expect(validated).toBe(true);
  expect(result.updatedCore).toBe(false);
  expect(result.coreBlocked).toBe(true);
});
