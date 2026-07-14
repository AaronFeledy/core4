import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";

import { writeAppCommandCacheStrict } from "../../src/cache/command-index-writer.ts";
import { resolveToolingRoute } from "../../src/cli/tooling-router.ts";

const withApp = async <T>(run: (root: string, cacheRoot: string) => Promise<T>): Promise<T> => {
  const fixtureRoot = await mkdtemp(join(tmpdir(), "lando-tooling-router-unit-"));
  const root = join(fixtureRoot, "app");
  const cacheRoot = join(fixtureRoot, "cache");
  await mkdir(root, { recursive: true });
  try {
    return await run(root, cacheRoot);
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
  }
};

const writeFreshCache = async (
  root: string,
  cacheRoot: string,
  entries: ReadonlyArray<{ readonly id: string; readonly summary: string; readonly hidden: boolean }>,
): Promise<void> => {
  const landofile = { name: "router-test" };
  await writeFile(join(root, ".lando.yml"), "name: router-test\n");
  await Effect.runPromise(
    writeAppCommandCacheStrict({ landofile, entries, cwd: root, cacheRoot, now: () => 100 }),
  );
};

test("Given a fresh cached app task, when resolving its bare name, then it routes to the canonical task", async () => {
  await withApp(async (root, cacheRoot) => {
    // Given
    await writeFreshCache(root, cacheRoot, [
      { id: "app:quality", summary: "Run quality checks", hidden: false },
    ]);

    // When
    const route = await Effect.runPromise(
      resolveToolingRoute({ argv: ["quality", "--fix"], cwd: root, cacheRoot }),
    );

    // Then
    expect(route).toEqual({
      _tag: "tooling",
      commandId: "app:quality",
      name: "quality",
      argv: ["--fix"],
    });
  });
});

test("Given a fresh cached app task, when resolving version, then the flag remains task argv", async () => {
  await withApp(async (root, cacheRoot) => {
    // Given
    await writeFreshCache(root, cacheRoot, [
      { id: "app:quality", summary: "Run quality checks", hidden: false },
    ]);

    // When
    const route = await Effect.runPromise(
      resolveToolingRoute({ argv: ["quality", "--version"], cwd: root, cacheRoot }),
    );

    // Then
    expect(route).toMatchObject({
      _tag: "tooling",
      commandId: "app:quality",
      argv: ["--version"],
    });
  });
});

test("Given a fresh cached app task, when resolving its canonical id, then it routes to the same task", async () => {
  await withApp(async (root, cacheRoot) => {
    // Given
    await writeFreshCache(root, cacheRoot, [
      { id: "app:quality", summary: "Run quality checks", hidden: false },
    ]);

    // When
    const route = await Effect.runPromise(
      resolveToolingRoute({ argv: ["app:quality", "--fix"], cwd: root, cacheRoot }),
    );

    // Then
    expect(route).toEqual({
      _tag: "tooling",
      commandId: "app:quality",
      name: "quality",
      argv: ["--fix"],
    });
  });
});

test("Given an uncached Landofile task, when resolving it, then the router does not parse and register it", async () => {
  await withApp(async (root, cacheRoot) => {
    // Given
    await writeFreshCache(root, cacheRoot, [{ id: "app:cached", summary: "Cached task", hidden: false }]);
    await writeFile(
      join(root, ".lando.yml"),
      ["name: router-test", "tooling:", "  uncached:", "    cmd: echo must-not-run", ""].join("\n"),
    );

    // When
    const route = await Effect.runPromise(resolveToolingRoute({ argv: ["uncached"], cwd: root, cacheRoot }));

    // Then
    expect(route).toMatchObject({
      _tag: "cache-miss",
      remediation: expect.stringContaining("lando app cache refresh"),
    });
  });
});

test("Given a fresh app cache, when resolving an unknown task, then it returns tagged remediation", async () => {
  await withApp(async (root, cacheRoot) => {
    // Given
    await writeFreshCache(root, cacheRoot, [{ id: "app:cached", summary: "Cached task", hidden: false }]);

    // When
    const route = await Effect.runPromise(resolveToolingRoute({ argv: ["unknown"], cwd: root, cacheRoot }));

    // Then
    expect(route).toMatchObject({
      _tag: "unknown-tooling",
      commandId: "app:unknown",
      remediation: expect.stringContaining("lando app cache refresh"),
    });
  });
});

test("Given another namespace or a directory outside an app, when resolving, then it is not tooling", async () => {
  await withApp(async (root, cacheRoot) => {
    // Given
    await writeFreshCache(root, cacheRoot, [
      { id: "app:quality", summary: "Run quality checks", hidden: false },
    ]);
    const outside = await mkdtemp(join(tmpdir(), "lando-tooling-router-outside-"));
    try {
      // When
      const [otherNamespace, outsideApp] = await Promise.all([
        Effect.runPromise(resolveToolingRoute({ argv: ["meta:quality"], cwd: root, cacheRoot })),
        Effect.runPromise(resolveToolingRoute({ argv: ["quality"], cwd: outside, cacheRoot })),
      ]);

      // Then
      expect(otherNamespace).toEqual({ _tag: "not-tooling" });
      expect(outsideApp).toEqual({ _tag: "not-tooling" });
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });
});

test("Given a stale version-policy cache, when resolving a task, then it requires refresh without running it", async () => {
  await withApp(async (root, cacheRoot) => {
    // Given
    const marker = join(root, "task-ran");
    await mkdir(join(root, ".lando", "scripts"), { recursive: true });
    await writeFile(
      join(root, ".lando", "scripts", "policy-check.bun.sh"),
      ["# ---", "# desc: Must remain cache-gated", "# ---", `echo ran > ${marker}`, ""].join("\n"),
    );
    await writeFreshCache(root, cacheRoot, [
      { id: "app:policy-check", summary: "Policy check", hidden: false },
    ]);
    await writeFile(join(root, ".lando.yml"), "name: router-test\nlando: '>=99'\n");

    // When
    const route = await Effect.runPromise(
      resolveToolingRoute({ argv: ["policy-check"], cwd: root, cacheRoot }),
    );

    // Then
    expect(route).toMatchObject({
      _tag: "cache-miss",
      remediation: expect.stringContaining("lando app cache refresh"),
    });
    expect(await Bun.file(marker).exists()).toBe(false);
  });
});

test("Given a missing cache with a remote include, when resolving, then it performs no task or network side effect", async () => {
  await withApp(async (root, cacheRoot) => {
    // Given
    let requests = 0;
    const server = Bun.serve({
      port: 0,
      fetch: () => {
        requests += 1;
        return new Response("name: fetched\n");
      },
    });
    const marker = join(root, "task-ran");
    await mkdir(join(root, ".lando", "scripts"), { recursive: true });
    await writeFile(
      join(root, ".lando", "scripts", "offline.bun.sh"),
      ["# ---", "# desc: Must remain cache-gated", "# ---", `echo ran > ${marker}`, ""].join("\n"),
    );
    await writeFile(
      join(root, ".lando.yml"),
      ["name: router-test", "includes:", `  - http://127.0.0.1:${server.port}/remote.yml`, ""].join("\n"),
    );
    try {
      // When
      const route = await Effect.runPromise(resolveToolingRoute({ argv: ["offline"], cwd: root, cacheRoot }));

      // Then
      expect(route).toMatchObject({
        _tag: "cache-miss",
        remediation: expect.stringContaining("lando app cache refresh"),
      });
      expect(requests).toBe(0);
      expect(await Bun.file(marker).exists()).toBe(false);
    } finally {
      server.stop(true);
    }
  });
});
