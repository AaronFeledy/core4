import { expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import {
  readFreshAppCommandCacheForCwd,
  writeAppCommandCacheStrict,
} from "../../src/cache/command-index-writer.ts";
import { commandScriptFingerprints, commandScriptsFresh } from "../../src/cache/command-script-freshness.ts";

const withCache = async (run: (root: string, cacheRoot: string, path: string) => Promise<void>) => {
  const root = await mkdtemp(join(tmpdir(), "lando-script-freshness-"));
  const cacheRoot = join(root, "cache");
  const path = join(root, ".lando/scripts/probe.bun.sh");
  try {
    await mkdir(join(root, ".lando/scripts"), { recursive: true });
    await writeFile(join(root, ".lando.yml"), "name: freshness\n");
    await writeFile(path, "# ---\n# desc: Probe\n# ---\necho before\n");
    await Effect.runPromise(
      writeAppCommandCacheStrict({
        cwd: root,
        cacheRoot,
        landofile: { name: "freshness" },
        entries: [{ id: "app:probe", summary: "Probe", hidden: false, source: "bun-script" }],
      }),
    );
    await run(root, cacheRoot, path);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
};

test("body edits leave script routing fingerprints fresh", async () => {
  await withCache(async (root, cacheRoot, path) => {
    await writeFile(path, "# ---\n# desc: Probe\n# ---\necho a much longer body\n");
    const cache = await Effect.runPromise(readFreshAppCommandCacheForCwd({ cwd: root, cacheRoot }));
    expect(cache?.entries[0]?.id).toBe("app:probe");
  });
});

test("unreadable scripts remain typed I/O failures rather than stale metadata", async () => {
  // Given
  await withCache(async (root, _cacheRoot, path) => {
    const fingerprints = await commandScriptFingerprints(root);
    await chmod(path, 0o000);
    try {
      // When / Then
      await expect(commandScriptsFresh(root, fingerprints)).rejects.toMatchObject({
        _tag: "BunShellScriptFrontMatterError",
      });
      await expect(commandScriptFingerprints(root)).rejects.toMatchObject({
        _tag: "BunShellScriptFrontMatterError",
      });
    } finally {
      await chmod(path, 0o644);
    }
  });
});

test.each(["args", "flags"])(
  "invalidates metadata when implicit %s declaration order changes",
  async (group) => {
    await withCache(async (root, _cacheRoot, path) => {
      // Given: identical keys and values, with insertion order determining positional order.
      await writeFile(path, `# ---\n# ${group}:\n#   first: {}\n#   second: {}\n# ---\necho ok\n`);
      const fingerprints = await commandScriptFingerprints(root);
      await writeFile(path, `# ---\n# ${group}:\n#   second: {}\n#   first: {}\n# ---\necho ok\n`);
      // When
      const fresh = await commandScriptsFresh(root, fingerprints);
      // Then
      expect(fresh).toBe(false);
    });
  },
);

test.each(["desc", "description", "summary", "service"])(
  "%s front-matter edits stale routing after body-only edits stayed fresh",
  async (key) => {
    await withCache(async (root, cacheRoot, path) => {
      await writeFile(path, "# ---\n# desc: Probe\n# ---\necho after\n");
      expect(
        await Effect.runPromise(readFreshAppCommandCacheForCwd({ cwd: root, cacheRoot })),
      ).not.toBeNull();
      await writeFile(path, `# ---\n# desc: Probe\n# ${key}: changed\n# ---\necho after\n`);
      expect(await Effect.runPromise(readFreshAppCommandCacheForCwd({ cwd: root, cacheRoot }))).toBeNull();
    });
  },
);

test("additions and removals leave the index usable for routing", async () => {
  await withCache(async (root, cacheRoot, path) => {
    await writeFile(join(root, ".lando/scripts/new.bun.sh"), "# ---\n# ---\necho new\n");
    await rm(path);
    const cache = await Effect.runPromise(readFreshAppCommandCacheForCwd({ cwd: root, cacheRoot }));
    expect(cache?.entries[0]?.id).toBe("app:probe");
  });
});

test("one malformed script does not fail the command cache write", async () => {
  const root = await mkdtemp(join(tmpdir(), "lando-script-freshness-invalid-"));
  const cacheRoot = join(root, "cache");
  try {
    await mkdir(join(root, ".lando/scripts"), { recursive: true });
    await writeFile(join(root, ".lando.yml"), "name: freshness\n");
    await writeFile(join(root, ".lando/scripts/probe.bun.sh"), "# ---\n# desc: Probe\n# ---\necho ok\n");
    await writeFile(join(root, ".lando/scripts/broken.bun.sh"), "not front matter\n");
    await Effect.runPromise(
      writeAppCommandCacheStrict({
        cwd: root,
        cacheRoot,
        landofile: { name: "freshness" },
        entries: [{ id: "app:probe", summary: "Probe", hidden: false, source: "bun-script" }],
      }),
    );
    const cache = await Effect.runPromise(readFreshAppCommandCacheForCwd({ cwd: root, cacheRoot }));
    expect(cache?.entries[0]?.id).toBe("app:probe");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
