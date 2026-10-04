import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { updateLandofileIncludes } from "../src/includes.ts";
import { makeTestLandofileStateStore } from "./support.ts";

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

  for (const fixture of [
    {
      source: "github:acme/fragments",
      sourceId: "github:acme/fragments/postgres.yml",
      resolved: "abc123",
      cachePath: ["git", "abc123", "postgres.yml"],
    },
    {
      source: "npm:@acme/fragments",
      sourceId: "npm:@acme/fragments",
      resolved: "1.2.3",
      cachePath: ["npm", "-acme-fragments-1.2.3", "package", "postgres.yml"],
    },
  ]) {
    test(`${fixture.source} reports an absent lock entry`, async () => {
      // Given: no lockfile and no acquisition ports.
      const options = {
        landofile: { includes: [{ source: fixture.source, path: "postgres.yml" }] },
        appRoot: root,
        cacheRoot: join(root, "cache"),
        stateStore: makeTestLandofileStateStore(),
        noNetwork: true,
      };
      // When: an offline refresh attempts to resolve the include.
      const error = await Effect.runPromise(Effect.flip(updateLandofileIncludes(options)));
      // Then: the complete diagnostic retains the authored source and network guidance.
      expect(error).toMatchObject({
        _tag: "LandofileIncludeError",
        kind: "source-unresolved",
        source: fixture.source,
        message: `--no-network: no lockfile entry for ${fixture.source} to resolve from cache.`,
        remediation,
      });
    });

    test(`${fixture.source} reports an absent cached fragment`, async () => {
      // Given: a locked source whose published fragment is missing.
      await writeFile(
        join(root, ".lando.lock.yml"),
        `includes:\n  - source: ${fixture.sourceId}\n    resolved: ${fixture.resolved}\n    checksum: ${"a".repeat(64)}\n`,
      );
      const cacheRoot = join(root, "cache");
      const filePath = join(cacheRoot, "includes", ...fixture.cachePath);
      // When: offline resolution uses the lock without acquisition ports.
      const error = await Effect.runPromise(
        Effect.flip(
          updateLandofileIncludes({
            landofile: { includes: [{ source: fixture.source, path: "postgres.yml" }] },
            appRoot: root,
            cacheRoot,
            stateStore: makeTestLandofileStateStore(),
            noNetwork: true,
          }),
        ),
      );
      // Then: the full diagnostic identifies the provider-specific cache path.
      expect(error).toMatchObject({
        _tag: "LandofileIncludeError",
        kind: "fetch-failed",
        source: fixture.source,
        message: `--no-network: cached fragment for ${fixture.source} is missing at ${filePath}.`,
        remediation,
      });
    });
  }
});
