import { expect, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { resolveAuthoredIncludes } from "./include-pipeline.ts";
import { isIncludeLockKey, makeTestLandofilePorts, makeTestLandofileStateStore } from "./support.ts";

test("load merges entries written after its initial lock read under the operation lock", async () => {
  // Given
  const root = await mkdtemp(join(tmpdir(), "lando-lock-merge-"));
  const sha = "a".repeat(40);
  const content = "services: {}\n";
  const checksum = new Bun.CryptoHasher("sha256").update(content).digest("hex");
  const cacheRoot = join(root, "cache");
  const store = makeTestLandofileStateStore(cacheRoot);
  const locks: string[] = [];
  try {
    // When
    await Effect.runPromise(
      resolveAuthoredIncludes({
        appRoot: root,
        cacheRoot,
        ports: makeTestLandofilePorts(cacheRoot),
        stateStore: {
          ...store,
          withLock: (key, body) => {
            locks.push(key);
            return store.withLock(key, body);
          },
        },
        landofile: { includes: [{ source: "github:acme/shared", path: "web.yml" }] },
        deps: {
          git: {
            fetch: async ({ dest }) => {
              await Bun.write(
                join(root, ".lando.lock.yml"),
                `includes:\n  - source: github:acme/other/web.yml\n    resolved: ${sha}\n    checksum: ${checksum}\n`,
              );
              await Bun.write(join(dest, "web.yml"), content);
              return { commit: sha };
            },
          },
        },
      }),
    );
    // Then
    expect(Bun.YAML.parse(await Bun.file(join(root, ".lando.lock.yml")).text())).toMatchObject({
      includes: [
        { source: "github:acme/other/web.yml", resolved: sha, checksum },
        { source: "github:acme/shared/web.yml", resolved: sha, checksum },
      ],
    });
    expect(locks.filter(isIncludeLockKey)).toEqual([
      expect.stringMatching(/^landofile-include-lock-[a-f0-9]{64}$/u),
    ]);
    expect(await readdir(root)).not.toContain(".lando.lock.yml.lock");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
