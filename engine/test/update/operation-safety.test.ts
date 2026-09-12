import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProcessRunner, Telemetry } from "@lando/sdk/services";
import { Effect } from "effect";
import { type UpdateOptions, update } from "../../src/update/operation";

const roots: string[] = [];
const binaryBytes = new TextEncoder().encode("candidate");
const binarySha = createHash("sha256").update(binaryBytes).digest("hex");
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
  const binary = { url: "https://fixture.invalid/lando", sha256: binarySha, size: binaryBytes.length };
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

test.each(["download", "verify", "replace"])(
  "completed plugin receipts survive a binary %s failure",
  async (failure) => {
    // Given: plugin work completed before the binary request fails.
    const options = await fixture();
    const rows = [
      {
        kind: "plugin",
        name: "fixture",
        currentVersion: "1.0.0",
        targetVersion: "1.1.0",
        status: "update",
        reason: "selected",
      },
    ] as const;
    const fetchManifestBytes = options.fetchManifestBytes;
    if (fetchManifestBytes === undefined) throw new Error("missing fixture fetcher");
    // When: the combined update reaches binary download.
    const result = await run({
      ...options,
      selfUpdate: { executablePath: join(roots[0] ?? "", "lando"), platform: "linux", arch: "x64", argv: [] },
      fetchManifestBytes: async (url) => {
        if (url === "https://fixture.invalid/lando") {
          if (failure === "download") throw new Error("fixture download failed");
          return binaryBytes;
        }
        if (url === "https://fixture.invalid/SHA256SUMS")
          return new TextEncoder().encode(`${failure === "verify" ? "b".repeat(64) : binarySha}  lando\n`);
        return fetchManifestBytes(url);
      },
      verifyChecksumSignature: () => Effect.void,
      runPluginUpdates: () =>
        Effect.succeed({ rows, updatedPlugins: ["fixture"], blockCore: false, hasFailures: false }),
    });
    // Then: the terminal result retains the completed rows and signals failure.
    expect(result.updatedPlugins).toEqual(["fixture"]);
    expect(result.pluginResults).toEqual(rows);
    expect(result.updatedCore).toBe(false);
    expect(result.hasFailures).toBe(true);
    expect(result.coreFailure?.tag).toBe(
      failure === "download"
        ? "UpdateNetworkError"
        : failure === "verify"
          ? "UpdateChecksumVerificationError"
          : "UpdatePermissionError",
    );
  },
);
