import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UpdateManifestSchema } from "@lando/sdk/schema";
import * as StateStoreLayer from "@lando/state-store/service";
import { Effect, Schema } from "effect";
import {
  enforceManifestFreshness,
  readUpdateManifestState,
  recordUpdateManifestSuccess,
  writeUpdateFailureState,
} from "../../src/update/manifest.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const hex = "a".repeat(64);
const manifest = (latest: string) =>
  Schema.decodeUnknownSync(UpdateManifestSchema)({
    channel: "stable",
    latest,
    released: "2026-06-17T00:00:00Z",
    minimum: "4.0.0",
    binaries: {
      "linux-x64": { url: "https://fixture.invalid/lando", sha256: hex, size: 1 },
      "linux-arm64": { url: "https://fixture.invalid/lando", sha256: hex, size: 1 },
      "darwin-x64": { url: "https://fixture.invalid/lando", sha256: hex, size: 1 },
      "darwin-arm64": { url: "https://fixture.invalid/lando", sha256: hex, size: 1 },
      "windows-x64": { url: "https://fixture.invalid/lando", sha256: hex, size: 1 },
    },
    checksums: {
      url: "https://fixture.invalid/SHA256SUMS",
      signature: "https://fixture.invalid/SHA256SUMS.sig",
    },
    notes: "https://fixture.invalid/notes",
  });

const run = <A, E>(effect: Effect.Effect<A, E>) =>
  Effect.runPromise(effect.pipe(Effect.provide(StateStoreLayer.layer)));

test("A admits 4.2, B admits and records 4.3, A success cannot lower floor, then 4.2 is rejected", async () => {
  // Given an empty freshness bucket shared by two sequential update attempts.
  const root = await mkdtemp(join(tmpdir(), "lando-freshness-interleave-"));
  roots.push(root);
  const statePath = join(root, "update-manifest-state.json");

  // When A admits signed 4.2 under the advisory lock.
  await run(enforceManifestFreshness(manifest("4.2.0"), statePath, { persist: true }));

  // And B admits and records a newer 4.3 floor before A finishes.
  await run(enforceManifestFreshness(manifest("4.3.0"), statePath, { persist: true }));
  await run(recordUpdateManifestSuccess(statePath, "stable", "4.3.0"));

  // Then A's delayed success for 4.2 must not lower the channel floor.
  await run(recordUpdateManifestSuccess(statePath, "stable", "4.2.0"));
  const afterA = JSON.parse(await readFile(statePath, "utf8"));
  expect(afterA).toEqual({
    version: 2,
    data: { stable: { latest: "4.3.0" } },
  });

  // And a later 4.2 observation is refused as replay.
  const result = await run(
    Effect.result(enforceManifestFreshness(manifest("4.2.0"), statePath, { persist: true })),
  );
  expect(result).toMatchObject({
    _tag: "Failure",
    failure: { _tag: "UpdateManifestReplayError", cachedVersion: "4.3.0", manifestVersion: "4.2.0" },
  });
  // Floor remains 4.3 after the rejected attempt.
  expect(JSON.parse(await readFile(statePath, "utf8")).data.stable.latest).toBe("4.3.0");
});

test("failure and success writes preserve channel floors and failure metadata", async () => {
  const root = await mkdtemp(join(tmpdir(), "lando-freshness-failure-"));
  roots.push(root);
  const statePath = join(root, "state.json");
  await writeFile(
    statePath,
    `${JSON.stringify(
      {
        version: 1,
        data: {
          next: { latest: "5.0.0-next.1" },
          stable: { latest: "4.5.0" },
        },
      },
      null,
      2,
    )}\n`,
  );

  await run(
    writeUpdateFailureState({
      path: statePath,
      channel: "dev",
      category: "network_failure",
      targetVersion: "4.0.0-dev.9",
      platform: "linux-x64",
    }),
  );
  await run(
    writeUpdateFailureState({
      path: statePath,
      channel: "stable",
      category: "launch_probe_failure",
      targetVersion: "4.4.0",
      platform: "linux-x64",
    }),
  );
  await run(recordUpdateManifestSuccess(statePath, "stable", "4.4.0"));

  expect(JSON.parse(await readFile(statePath, "utf8"))).toEqual({
    version: 2,
    data: {
      next: { latest: "5.0.0-next.1" },
      stable: {
        latest: "4.5.0",
        lastFailure: {
          category: "launch_probe_failure",
          targetVersion: "4.4.0",
          platform: "linux-x64",
        },
      },
      dev: {
        latest: "4.0.0-dev.9",
        lastFailure: {
          category: "network_failure",
          targetVersion: "4.0.0-dev.9",
          platform: "linux-x64",
        },
      },
    },
  });
});

test.each(["4.3.0", "4.5.0", "4.7.0"])(
  "v1 migration preserves failure history and never lowers either observation (%s)",
  async (targetVersion) => {
    const root = await mkdtemp(join(tmpdir(), "lando-freshness-migrate-"));
    roots.push(root);
    const path = join(root, "state.json");
    const lastFailure = { category: "network_failure", targetVersion, platform: "linux-x64" } as const;
    await writeFile(
      path,
      JSON.stringify({
        version: 1,
        data: {
          stable: { latest: "4.5.0", lastFailure },
          next: { latest: "5.0.0-next.1" },
        },
      }),
    );

    const state = await run(readUpdateManifestState(path));

    expect(state).toEqual({
      stable: { latest: targetVersion === "4.7.0" ? "4.7.0" : "4.5.0", lastFailure },
      next: { latest: "5.0.0-next.1" },
    });
    await run(recordUpdateManifestSuccess(path, "stable", "4.4.0"));
    expect(JSON.parse(await readFile(path, "utf8")).version).toBe(2);
    expect(JSON.parse(await readFile(path, "utf8")).data).toEqual(state);
  },
);

test("v2 rejects a failure above its floor for every writer without changing bytes", async () => {
  const root = await mkdtemp(join(tmpdir(), "lando-freshness-contradiction-"));
  roots.push(root);
  const path = join(root, "state.json");
  const raw = JSON.stringify({
    version: 2,
    data: {
      stable: {
        latest: "4.2.0",
        lastFailure: { category: "network_failure", targetVersion: "4.3.0", platform: "linux-x64" },
      },
    },
  });
  await writeFile(path, raw);

  for (const action of [
    readUpdateManifestState(path),
    recordUpdateManifestSuccess(path, "stable", "4.4.0"),
    enforceManifestFreshness(manifest("4.4.0"), path, { persist: true }),
  ]) {
    expect(await run(Effect.result(action))).toMatchObject({
      _tag: "Failure",
      failure: { _tag: "UpdateNetworkError" },
    });
  }
  await run(
    writeUpdateFailureState({
      path,
      channel: "stable",
      category: "network_failure",
      targetVersion: "4.4.0",
      platform: "linux-x64",
    }),
  );
  expect(await readFile(path, "utf8")).toBe(raw);
});

test("delayed failure replaces history while concurrent observations retain the highest floor", async () => {
  const root = await mkdtemp(join(tmpdir(), "lando-freshness-concurrent-"));
  roots.push(root);
  const path = join(root, "state.json");
  await run(
    writeUpdateFailureState({
      path,
      channel: "stable",
      category: "network_failure",
      targetVersion: "4.2.0",
      platform: "linux-x64",
    }),
  );
  await Promise.all([
    run(enforceManifestFreshness(manifest("4.6.0"), path, { persist: true })),
    run(recordUpdateManifestSuccess(path, "stable", "4.5.0")),
    run(
      writeUpdateFailureState({
        path,
        channel: "stable",
        category: "permission_failure",
        targetVersion: "4.3.0",
        platform: "darwin-arm64",
      }),
    ),
  ]);
  expect(await run(readUpdateManifestState(path))).toEqual({
    stable: {
      latest: "4.6.0",
      lastFailure: { category: "permission_failure", targetVersion: "4.3.0", platform: "darwin-arm64" },
    },
  });
});

test("unknown envelope version fails with UpdateNetworkError corrupt wording", async () => {
  const root = await mkdtemp(join(tmpdir(), "lando-freshness-version-"));
  roots.push(root);
  const statePath = join(root, "state.json");
  await writeFile(
    statePath,
    `${JSON.stringify({ version: 99, data: { stable: { latest: "9.9.9" } } }, null, 2)}\n`,
  );

  const result = await run(
    Effect.result(enforceManifestFreshness(manifest("4.2.0"), statePath, { persist: false })),
  );
  expect(result).toMatchObject({
    _tag: "Failure",
    failure: {
      _tag: "UpdateNetworkError",
      message: expect.stringContaining("failed schema validation"),
      remediation: expect.stringContaining("Remove the corrupt freshness file"),
    },
  });
});

test.each(["malformed envelope", '{"version":99,"data":{"stable":{"latest":"9.9.9"}}}'])(
  "best-effort failure recording leaves unreadable freshness state untouched (%s)",
  async (raw) => {
    const root = await mkdtemp(join(tmpdir(), "lando-freshness-corrupt-"));
    roots.push(root);
    const path = join(root, "state.json");
    await writeFile(path, raw);

    await run(
      writeUpdateFailureState({
        path,
        channel: "stable",
        category: "network_failure",
        targetVersion: "4.2.0",
        platform: "linux-x64",
      }),
    );

    expect(await readFile(path, "utf8")).toBe(raw);
  },
);

test.each([
  ["a misspelled channel", { stablE: { latest: "9.9.9" } }],
  ["an unknown entry field", { stable: { latest: "9.9.9", pinned: true } }],
  ["a non-semver floor", { stable: { latest: "nonsense" } }],
])("an unrecognized floor record (%s) fails closed and keeps its bytes", async (_label, data) => {
  const root = await mkdtemp(join(tmpdir(), "lando-freshness-unknown-"));
  roots.push(root);
  const statePath = join(root, "state.json");
  const raw = `${JSON.stringify({ version: 1, data }, null, 2)}\n`;
  await writeFile(statePath, raw);

  const admission = await run(
    Effect.result(enforceManifestFreshness(manifest("4.2.0"), statePath, { persist: true })),
  );
  const success = await run(Effect.result(recordUpdateManifestSuccess(statePath, "stable", "4.2.0")));

  for (const result of [admission, success]) {
    expect(result).toMatchObject({
      _tag: "Failure",
      failure: {
        _tag: "UpdateNetworkError",
        remediation: expect.stringContaining("Remove the corrupt freshness file"),
      },
    });
  }
  expect(await readFile(statePath, "utf8")).toBe(raw);
});
