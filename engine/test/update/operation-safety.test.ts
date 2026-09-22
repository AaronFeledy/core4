import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProcessRunner, Telemetry } from "@lando/sdk/services";
import { Effect, Either } from "effect";
import { withPluginMutationLock } from "../../src/plugins/mutation-lock";
import { guardCoreReplacement } from "../../src/update/compatibility";
import { type UpdateOptions, update } from "../../src/update/operation";

const roots: string[] = [];
const originalDataRoot = process.env.LANDO_USER_DATA_ROOT;
const binaryBytes = new TextEncoder().encode("candidate");
const binarySha = createHash("sha256").update(binaryBytes).digest("hex");
afterEach(async () => {
  if (originalDataRoot === undefined) Reflect.deleteProperty(process.env, "LANDO_USER_DATA_ROOT");
  else process.env.LANDO_USER_DATA_ROOT = originalDataRoot;
  for (const root of roots) {
    expect(await readFile(join(root, "bin", "lando"), "utf8")).toBe("hostile-lando3");
    expect((await stat(join(root, "bin", "lando"))).mode & 0o777).toBe(0o755);
    expect(await Bun.file(join(root, "bin", "lando.bak")).exists()).toBe(false);
  }
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

test.each([
  { result: { hasFailures: true }, outcome: "network_failure" },
  { result: { coreBlocked: true }, outcome: "permission_failure" },
  {
    result: {
      coreFailure: {
        tag: "UpdateChecksumVerificationError",
        message: "verification failed",
        remediation: "retry",
      },
    },
    outcome: "signature_failure",
  },
  {
    result: { coreFailure: { tag: "UpdatePermissionError", message: "exec failed", remediation: "retry" } },
    outcome: "permission_failure",
  },
])("reports $outcome for returned update failures", async ({ result, outcome }) => {
  const records: Readonly<Record<string, unknown>>[] = [];
  await Effect.runPromise(
    update({
      runUpdate: () => Effect.succeed({ updatedCore: false, updatedPlugins: [], ...result }),
    }).pipe(
      Effect.provideService(Telemetry, {
        enabled: true,
        record: (_, data) =>
          Effect.sync(() => {
            records.push(data);
          }),
      }),
      Effect.provideService(ProcessRunner, {
        run: () => Effect.succeed({ exitCode: 0, stdout: "", stderr: "" }),
        stream: () => {
          throw new Error("unused");
        },
      }),
    ),
  );
  expect(records).toHaveLength(1);
  expect(records[0]?.outcome).toBe(outcome);
});
const fixture = async (): Promise<UpdateOptions> => {
  const root = await mkdtemp(join(tmpdir(), "lando-core-safety-"));
  roots.push(root);
  await mkdir(join(root, "bin"));
  await mkdir(join(root, "install"));
  await writeFile(join(root, "bin", "lando4"), "old", { mode: 0o755 });
  await writeFile(join(root, "bin", "lando"), "hostile-lando3", { mode: 0o755 });
  await writeFile(
    join(root, "install", "record.json"),
    JSON.stringify({
      version: 1,
      data: {
        executable: {
          path: join(root, "bin", "lando4"),
          sha256: createHash("sha256").update("old").digest("hex"),
          size: 3,
          channel: "stable",
          platform: "linux-x64",
          releaseVersion: "4.1.0",
        },
        shellProfiles: [],
      },
    }),
    { mode: 0o600 },
  );
  process.env.LANDO_USER_DATA_ROOT = root;
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

test("failed re-exec cannot restore old core beneath a plugin activated after replacement", async () => {
  // Given a real mutation lock guarding a compatible empty active set.
  const options = await fixture();
  const root = roots[roots.length - 1];
  if (root === undefined || options.fetchManifestBytes === undefined) throw new Error("missing fixture");
  const fetchManifest = options.fetchManifestBytes;
  const executablePath = join(root, "bin", "lando4");
  const pluginsRoot = join(root, "plugins");
  await writeFile(executablePath, "old");
  const precondition = { pluginsRoot, currentCoreVersion: "4.1.0", targetCoreVersion: "4.2.0" };
  // When a competing invocation activates a new-core-only plugin after lock release,
  // then execve fails in the original invocation.
  const result = await run({
    ...options,
    verifyChecksumSignature: () => Effect.void,
    fetchManifestBytes: async (url) =>
      url === "https://fixture.invalid/lando"
        ? binaryBytes
        : url === "https://fixture.invalid/SHA256SUMS"
          ? new TextEncoder().encode(`${binarySha}  lando\n`)
          : fetchManifest(url),
    runPluginUpdates: () =>
      Effect.succeed({
        rows: [],
        updatedPlugins: [],
        blockCore: false,
        hasFailures: false,
        guardCoreReplacement: (body) => guardCoreReplacement(precondition, body),
      }),
    selfUpdate: {
      platform: "linux",
      arch: "x64",
      argv: [],
      execve: () =>
        withPluginMutationLock(
          pluginsRoot,
          "plugin:add",
          Effect.tryPromise(async () => {
            expect(await Bun.file(executablePath).text()).toBe("candidate");
            const plugin = join(root, "new-only");
            await mkdir(plugin);
            await writeFile(
              join(plugin, "package.json"),
              JSON.stringify({
                name: "new-only",
                version: "1.0.0",
                landoPlugin: {
                  name: "new-only",
                  version: "1.0.0",
                  api: 4,
                  entry: "index.js",
                  requires: { "@lando/core": ">=4.2.0" },
                },
              }),
            );
            await writeFile(join(plugin, "index.js"), "export {};");
            await writeFile(
              join(pluginsRoot, "registry.json"),
              JSON.stringify({
                "new-only": { name: "new-only", version: "1.0.0", path: plugin, source: "linked" },
              }),
            );
          }),
        ).pipe(Effect.zipRight(Effect.fail(new Error("execve failed")))),
    },
  });
  // Then the active plugin still has the compatible core, with a retained backup and tagged failure.
  expect(result.hasFailures).toBe(true);
  expect(result.coreFailure?.tag).toBe("UpdatePermissionError");
  expect(await Bun.file(executablePath).text()).toBe("candidate");
  expect(await Bun.file(`${executablePath}.bak`).text()).toBe("old");
  expect((await Bun.file(join(root, "install", "record.json")).json()).data.executable).toMatchObject({
    sha256: binarySha,
    size: binaryBytes.length,
    releaseVersion: "4.2.0",
  });
});

test.each(["post-swap-probe", "record-refresh"] as const)(
  "restores the binary and old record after %s failure",
  async (failure) => {
    // Given an owned binary and a real, readable install record.
    const options = await fixture();
    const root = roots[0];
    const fetchManifest = options.fetchManifestBytes;
    if (root === undefined || fetchManifest === undefined) throw new Error("missing fixture");
    const executablePath = join(root, "bin", "lando4");
    const recordFile = join(root, "install", "record.json");
    const originalRecord = await readFile(recordFile, "utf8");
    let probes = 0;
    let execs = 0;
    try {
      // When the post-swap probe fails or makes the record directory unwritable.
      const outcome = await Effect.runPromise(
        update({
          ...options,
          selfUpdate: {
            platform: "linux",
            arch: "x64",
            execve: () =>
              Effect.sync(() => {
                execs += 1;
              }),
          },
          verifyChecksumSignature: () => Effect.void,
          fetchManifestBytes: async (url) =>
            url === "https://fixture.invalid/lando"
              ? binaryBytes
              : url === "https://fixture.invalid/SHA256SUMS"
                ? new TextEncoder().encode(`${binarySha}  lando\n`)
                : fetchManifest(url),
        }).pipe(
          Effect.provideService(Telemetry, { enabled: false, record: () => Effect.void }),
          Effect.provideService(ProcessRunner, {
            run: () =>
              Effect.promise(async () => {
                probes += 1;
                if (probes === 2 && failure === "record-refresh") await chmod(join(root, "install"), 0o500);
                return {
                  exitCode: probes === 2 && failure === "post-swap-probe" ? 126 : 0,
                  stdout: "",
                  stderr: "",
                };
              }),
            stream: () => {
              throw new Error("unused stream");
            },
          }),
          Effect.either,
        ),
      );
      // Then replacement rolls back before execve and leaves the old ownership proof intact.
      expect(Either.isLeft(outcome)).toBe(true);
      if (!Either.isLeft(outcome)) throw new Error("expected replacement failure");
      expect(outcome.left._tag).toBe(
        failure === "record-refresh" ? "InstallOwnershipError" : "UpdateLaunchProbeError",
      );
      expect(await readFile(executablePath, "utf8")).toBe("old");
      expect(await readFile(recordFile, "utf8")).toBe(originalRecord);
      expect(probes).toBe(2);
      expect(execs).toBe(0);
      expect((await readdir(join(root, "bin"))).sort()).toEqual(["lando", "lando4"]);
    } finally {
      await chmod(join(root, "install"), 0o700);
    }
  },
);

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
      selfUpdate: {
        platform: "linux",
        arch: "x64",
        argv: [],
        rename: async () => {
          throw new Error("fixture replacement failed");
        },
      },
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
