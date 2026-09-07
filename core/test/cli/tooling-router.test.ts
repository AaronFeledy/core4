import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";

import { writeAppCommandCacheStrict } from "@lando/engine/cache/command-index-writer";
import { resolveBuiltInCommand } from "../../src/cli/built-in-command-registry.ts";
import { resolveToolingRoute, toolingName, toolingRouteError } from "../../src/cli/tooling-router.ts";

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
  entries: ReadonlyArray<{
    readonly id: string;
    readonly summary: string;
    readonly hidden: boolean;
    readonly source?: "bun-script";
  }>,
): Promise<void> => {
  const landofile = { name: "router-test" };
  await writeFile(join(root, ".lando.yml"), "name: router-test\n");
  await Effect.runPromise(
    writeAppCommandCacheStrict({ landofile, entries, cwd: root, cacheRoot, now: () => 100 }),
  );
};

test("Given leading-hyphen global options, when deriving a tooling name, then they are not tooling", () => {
  // Given
  const tokens = ["--help", "-h"];

  // When
  const names = tokens.map(toolingName);

  // Then
  expect(names).toEqual([undefined, undefined]);
});

test("Given a fresh app cache, when help options are command heads, then they are not tooling", async () => {
  await withApp(async (root, cacheRoot) => {
    // Given
    await writeFreshCache(root, cacheRoot, [
      { id: "app:quality", summary: "Run quality checks", hidden: false },
    ]);

    // When
    const routes = await Promise.all(
      ["--help", "-h"].map((token) =>
        Effect.runPromise(resolveToolingRoute(token, { cwd: root, cacheRoot })),
      ),
    );

    // Then
    expect(routes).toEqual([{ _tag: "not-tooling" }, { _tag: "not-tooling" }]);
  });
});

test("Given a fresh cached Bun script, when resolving it, then it selects the script hot path", async () => {
  await withApp(async (root, cacheRoot) => {
    // Given
    await writeFreshCache(root, cacheRoot, [
      {
        id: "app:quality",
        summary: "Run quality checks",
        hidden: false,
        source: "bun-script",
      },
    ]);
    const argv = ["quality", "--fix"] as const;

    // When
    const route = await Effect.runPromise(resolveToolingRoute(argv[0], { cwd: root, cacheRoot }));

    // Then
    expect(route).toEqual({
      _tag: "bun-script",
      commandId: "app:quality",
      name: "quality",
      appRoot: root,
    });
    expect(argv.slice(1)).toEqual(["--fix"]);
  });
});

test("Given a fresh cached app task, when resolving its bare name, then it routes to the canonical task", async () => {
  await withApp(async (root, cacheRoot) => {
    // Given
    await writeFreshCache(root, cacheRoot, [
      { id: "app:quality", summary: "Run quality checks", hidden: false },
    ]);
    const argv = ["quality", "--fix"] as const;

    // When
    const route = await Effect.runPromise(resolveToolingRoute(argv[0], { cwd: root, cacheRoot }));

    // Then
    expect(route).toEqual({
      _tag: "tooling",
      commandId: "app:quality",
      name: "quality",
    });
    expect(argv.slice(1)).toEqual(["--fix"]);
  });
});

test("Given a fresh cached app task, when resolving version, then the flag remains task argv", async () => {
  await withApp(async (root, cacheRoot) => {
    // Given
    await writeFreshCache(root, cacheRoot, [
      { id: "app:quality", summary: "Run quality checks", hidden: false },
    ]);
    const argv = ["quality", "--version"] as const;

    // When
    const route = await Effect.runPromise(resolveToolingRoute(argv[0], { cwd: root, cacheRoot }));

    // Then
    expect(route).toMatchObject({
      _tag: "tooling",
      commandId: "app:quality",
    });
    expect(argv.slice(1)).toEqual(["--version"]);
  });
});

test("Given a fresh cached app task, when resolving its canonical id, then it routes to the same task", async () => {
  await withApp(async (root, cacheRoot) => {
    // Given
    await writeFreshCache(root, cacheRoot, [
      { id: "app:quality", summary: "Run quality checks", hidden: false },
    ]);
    const argv = ["app:quality", "--fix"] as const;

    // When
    const route = await Effect.runPromise(resolveToolingRoute(argv[0], { cwd: root, cacheRoot }));

    // Then
    expect(route).toEqual({
      _tag: "tooling",
      commandId: "app:quality",
      name: "quality",
    });
    expect(argv.slice(1)).toEqual(["--fix"]);
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
    const route = await Effect.runPromise(resolveToolingRoute("uncached", { cwd: root, cacheRoot }));

    // Then
    expect(route).toMatchObject({
      _tag: "cache-miss",
      remediation: expect.stringContaining("lando app:cache:refresh"),
    });
  });
});

test("Given a fresh app cache, when resolving an unknown task, then it returns tagged remediation", async () => {
  await withApp(async (root, cacheRoot) => {
    // Given
    await writeFreshCache(root, cacheRoot, [{ id: "app:cached", summary: "Cached task", hidden: false }]);

    // When
    const route = await Effect.runPromise(resolveToolingRoute("unknown", { cwd: root, cacheRoot }));

    // Then
    expect(route).toMatchObject({
      _tag: "unknown-tooling",
      commandId: "app:unknown",
      remediation: expect.stringContaining("lando app:cache:refresh"),
    });
  });
});

test("Given an argv-derived tooling name with terminal controls, when its error is constructed, then the message is escaped and the typed tool stays raw", () => {
  // Given
  const name = "unknown\u001b[31m";

  // When
  const error = toolingRouteError({
    _tag: "unknown-tooling",
    commandId: `app:${name}`,
    name,
    remediation: "refresh",
  });

  // Then
  expect(error.message).toContain("app:unknown\\u001b[31m");
  expect(error.message).not.toContain("\u001b");
  expect(error.tool).toBe(name);
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
        Effect.runPromise(resolveToolingRoute("meta:quality", { cwd: root, cacheRoot })),
        Effect.runPromise(resolveToolingRoute("quality", { cwd: outside, cacheRoot })),
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
    const route = await Effect.runPromise(resolveToolingRoute("policy-check", { cwd: root, cacheRoot }));

    // Then
    expect(route).toMatchObject({
      _tag: "cache-miss",
      remediation: expect.stringContaining("lando app:cache:refresh"),
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
      const route = await Effect.runPromise(resolveToolingRoute("offline", { cwd: root, cacheRoot }));

      // Then
      expect(route).toMatchObject({
        _tag: "cache-miss",
        remediation: expect.stringContaining("lando app:cache:refresh"),
      });
      expect(requests).toBe(0);
      expect(await Bun.file(marker).exists()).toBe(false);
    } finally {
      server.stop(true);
    }
  });
});

test("Given a cache-miss remediation, when extracting backticked lando commands, then each resolves in the built-in registry", async () => {
  await withApp(async (root, cacheRoot) => {
    // Given
    await writeFreshCache(root, cacheRoot, [{ id: "app:cached", summary: "Cached task", hidden: false }]);
    await writeFile(
      join(root, ".lando.yml"),
      ["name: router-test", "tooling:", "  uncached:", "    cmd: echo must-not-run", ""].join("\n"),
    );

    // When
    const route = await Effect.runPromise(resolveToolingRoute("uncached", { cwd: root, cacheRoot }));
    if (route._tag !== "cache-miss") {
      throw new Error(`expected cache-miss, got ${route._tag}`);
    }
    const tokens = [...route.remediation.matchAll(/`lando\s+([^`]+)`/g)].flatMap((match) => {
      const captured = match[1];
      return captured === undefined ? [] : [captured.trim()];
    });

    // Then
    expect(tokens.length).toBeGreaterThan(0);
    for (const token of tokens) {
      expect(resolveBuiltInCommand(token), `${token} must resolve in the built-in registry`).toBeDefined();
    }
    expect(tokens).toContain("app:cache:refresh");
  });
});
