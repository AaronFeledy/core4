import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { updateAuthoredIncludes as updateLandofileIncludes } from "./include-pipeline.ts";
import {
  makeTestLandofilePorts,
  makeTestLandofileStateStore,
  registryForOnly,
  seedGitSourceEntry,
  seedNpmSourceEntry,
} from "./support.ts";

const remediation =
  "Run lando app:includes:update with network access to populate the include cache before retrying with --no-network.";

describe("offline include diagnostics", () => {
  let root: string;
  beforeEach(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), "lando-offline-messages-")));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  test("github:acme/fragments reads a warm cache without acquisition ports", async () => {
    // Given: a matching lock and provider-specific published fragment.
    const content = "services:\n  db:\n    type: postgres\n";
    const checksum = new Bun.CryptoHasher("sha256").update(content).digest("hex");
    const cacheRoot = join(root, "cache");
    const commit = "a".repeat(40);
    await seedGitSourceEntry(cacheRoot, commit, { "postgres.yml": content });
    await writeFile(
      join(root, ".lando.lock.yml"),
      `includes:\n  - source: github:acme/fragments/postgres.yml\n    resolved: ${commit}\n    checksum: ${checksum}\n`,
    );
    // When: an offline refresh resolves only from disk.
    const report = await Effect.runPromise(
      updateLandofileIncludes({
        landofile: { includes: [{ source: "github:acme/fragments", path: "postgres.yml" }] },
        appRoot: root,
        cacheRoot,
        ports: makeTestLandofilePorts(cacheRoot),
        stateStore: makeTestLandofileStateStore(cacheRoot),
        noNetwork: true,
      }),
    );
    // Then: the lock identity, version, and content digest are unchanged.
    expect(report.entries).toEqual([
      {
        source: "github:acme/fragments/postgres.yml",
        resolved: commit,
        checksum,
        status: "unchanged",
      },
    ]);
    expect(report.wrote).toBe(false);
  });

  test("github:acme/fragments reports an absent lock entry", async () => {
    const cacheRoot = join(root, "cache");
    const options = {
      landofile: { includes: [{ source: "github:acme/fragments", path: "postgres.yml" }] },
      appRoot: root,
      cacheRoot,
      ports: makeTestLandofilePorts(cacheRoot),
      stateStore: makeTestLandofileStateStore(cacheRoot),
      noNetwork: true,
    };
    const error = await Effect.runPromise(Effect.flip(updateLandofileIncludes(options)));
    expect(error).toMatchObject({
      _tag: "LandofileIncludeError",
      kind: "source-unresolved",
      source: "github:acme/fragments",
      message:
        "--no-network: no matching pinned cache for github:acme/fragments at requested selector <default>.",
      remediation,
    });
  });

  test("github:acme/fragments reports an absent cached fragment", async () => {
    const commit = "a".repeat(40);
    await writeFile(
      join(root, ".lando.lock.yml"),
      `includes:\n  - source: github:acme/fragments/postgres.yml\n    resolved: ${commit}\n    checksum: ${"a".repeat(64)}\n`,
    );
    const cacheRoot = join(root, "cache");
    const error = await Effect.runPromise(
      Effect.flip(
        updateLandofileIncludes({
          landofile: { includes: [{ source: "github:acme/fragments", path: "postgres.yml" }] },
          appRoot: root,
          cacheRoot,
          ports: makeTestLandofilePorts(cacheRoot),
          stateStore: makeTestLandofileStateStore(cacheRoot),
          noNetwork: true,
        }),
      ),
    );
    expect(error).toMatchObject({
      _tag: "LandofileIncludeError",
      kind: "fetch-failed",
      source: "github:acme/fragments",
      message:
        "--no-network: cached fragment for github:acme/fragments at requested selector <default> is missing.",
      remediation,
    });
  });

  test("npm:@acme/fragments reads a warm cache without acquisition ports", async () => {
    const content = "services:\n  db:\n    type: postgres\n";
    const checksum = new Bun.CryptoHasher("sha256").update(content).digest("hex");
    const cacheRoot = join(root, "cache");
    const stateStore = makeTestLandofileStateStore(cacheRoot);
    await seedNpmSourceEntry({
      cacheRoot,
      stateStore,
      name: "@acme/fragments",
      version: "1.2.3",
      files: { "postgres.yml": content },
    });
    await writeFile(
      join(root, ".lando.lock.yml"),
      `includes:\n  - source: npm:@acme/fragments/postgres.yml\n    resolved: 1.2.3\n    checksum: ${checksum}\n`,
    );
    const npmRegistry = registryForOnly();
    const report = await Effect.runPromise(
      updateLandofileIncludes({
        landofile: { includes: [{ source: "npm:@acme/fragments", path: "postgres.yml" }] },
        appRoot: root,
        cacheRoot,
        ports: makeTestLandofilePorts(cacheRoot, cacheRoot, { npmRegistry }),
        stateStore,
        deps: { npmRegistry },
        noNetwork: true,
      }),
    );
    expect(report.entries).toEqual([
      {
        source: "npm:@acme/fragments/postgres.yml",
        resolved: "1.2.3",
        checksum,
        status: "unchanged",
      },
    ]);
    expect(report.wrote).toBe(false);
  });

  test("npm:@acme/fragments reports an absent lock entry", async () => {
    const cacheRoot = join(root, "cache");
    const npmRegistry = registryForOnly();
    const error = await Effect.runPromise(
      Effect.flip(
        updateLandofileIncludes({
          landofile: { includes: [{ source: "npm:@acme/fragments", path: "postgres.yml" }] },
          appRoot: root,
          cacheRoot,
          ports: makeTestLandofilePorts(cacheRoot, cacheRoot, { npmRegistry }),
          stateStore: makeTestLandofileStateStore(cacheRoot),
          deps: { npmRegistry },
          noNetwork: true,
        }),
      ),
    );
    expect(error).toMatchObject({
      _tag: "LandofileIncludeError",
      kind: "source-unresolved",
      source: "npm:@acme/fragments",
      message:
        "--no-network: no matching pinned cache for npm:@acme/fragments at requested selector <default>.",
      remediation,
    });
  });

  test("npm:@acme/fragments reports an absent cached fragment", async () => {
    await writeFile(
      join(root, ".lando.lock.yml"),
      `includes:\n  - source: npm:@acme/fragments/postgres.yml\n    resolved: 1.2.3\n    checksum: ${"a".repeat(64)}\n`,
    );
    const cacheRoot = join(root, "cache");
    const npmRegistry = registryForOnly();
    const error = await Effect.runPromise(
      Effect.flip(
        updateLandofileIncludes({
          landofile: { includes: [{ source: "npm:@acme/fragments", path: "postgres.yml" }] },
          appRoot: root,
          cacheRoot,
          ports: makeTestLandofilePorts(cacheRoot, cacheRoot, { npmRegistry }),
          stateStore: makeTestLandofileStateStore(cacheRoot),
          deps: { npmRegistry },
          noNetwork: true,
        }),
      ),
    );
    expect(error).toMatchObject({
      _tag: "LandofileIncludeError",
      kind: "fetch-failed",
      source: "npm:@acme/fragments",
      message:
        "--no-network: cached fragment for npm:@acme/fragments at requested selector <default> is missing.",
      remediation,
    });
  });
});
