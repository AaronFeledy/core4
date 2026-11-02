import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { serialize } from "node:v8";
import { normalizeToolingInput } from "@lando/landofile/tooling-input-normalize";
import { Context, Effect, Result, Schema } from "effect";

import {
  APP_COMMAND_MAGIC,
  COMMAND_INDEX_HEADER_BYTES,
  COMMAND_INDEX_SCHEMA_VERSION,
  type CommandIndexEntry,
} from "@lando/engine/cache/command-index";
import { writeAppCommandCacheStrict } from "@lando/engine/cache/command-index-writer";
import { appToolingCompilationCachePath } from "@lando/engine/cache/paths";
import type { LandofileShape } from "@lando/sdk/schema";
import { resolveBuiltInCommand } from "../../src/cli/built-in-command-registry.ts";
import { createPluginCommandCatalog } from "../../src/cli/plugin-command-catalog.ts";
import {
  type ToolingRoute,
  resolveAppCommandHelpAliases,
  resolveToolingRoute,
  toolingHelpRequested,
  toolingName,
  toolingRouteError,
} from "../../src/cli/tooling-router.ts";

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

for (const [token, commandId] of [
  ["stop", "app:stop"],
  ["destroy", "app:destroy"],
  ["doctor", "meta:doctor"],
  ["start", "app:start"],
  ["info", "app:info"],
] as const) {
  test(`routes ${token} to its built-in policy despite conflicting Landofile forms`, async () => {
    await withApp(async (root, cacheRoot) => {
      // Given
      await writeFile(join(root, ".lando.yml"), "name: conflict\n");
      await writeFile(join(root, ".lando.ts"), 'export default { name: "conflict" };\n');
      // When
      const route = await Effect.runPromise(resolveToolingRoute(token, { cwd: root, cacheRoot }));
      // Then
      expect(route).toMatchObject({ _tag: "built-in", commandId });
    });
  });
}

test("omits app help aliases when Landofile forms conflict", async () => {
  await withApp(async (root, cacheRoot) => {
    // Given
    await writeFile(join(root, ".lando.yml"), "name: conflict\n");
    await writeFile(join(root, ".lando.ts"), 'export default { name: "conflict" };\n');
    // When
    const aliases = await Effect.runPromise(resolveAppCommandHelpAliases({ cwd: root, cacheRoot }));
    // Then
    expect(aliases).toBeUndefined();
  });
});

const writeFreshCache = async (
  root: string,
  cacheRoot: string,
  entries: ReadonlyArray<CommandIndexEntry>,
  source: { readonly yaml: string; readonly landofile: LandofileShape } = {
    yaml: "name: router-test\n",
    landofile: { name: "router-test" },
  },
): Promise<void> => {
  await writeFile(join(root, ".lando.yml"), source.yaml);
  await Effect.runPromise(
    writeAppCommandCacheStrict({
      landofile: source.landofile,
      entries,
      cwd: root,
      cacheRoot,
      now: () => 100,
    }),
  );
};

/** Prior-generation app-command index (schema v2). Must never decode as a usable hit. */
const writeSchemaV2CacheBlob = async (
  root: string,
  cacheRoot: string,
  entries: ReadonlyArray<{
    readonly id: string;
    readonly summary: string;
    readonly hidden: boolean;
  }>,
): Promise<void> => {
  const sourceFile = join(root, ".lando.yml");
  await writeFile(sourceFile, "name: router-test\n");
  const schemaVersion = 2;
  const payload = {
    schemaVersion,
    landoVersion: "0.0.0",
    appName: "router-test",
    sourceFile,
    sourceMtimeMs: 0,
    sourceSize: 0,
    sourceLocalIncludePaths: [] as const,
    sourceReferencedFiles: [] as const,
    versionConstraints: [] as const,
    generatedAtMs: 100,
    entries,
  };
  const header = new Uint8Array(COMMAND_INDEX_HEADER_BYTES);
  header.set(APP_COMMAND_MAGIC, 0);
  new DataView(header.buffer).setBigUint64(4, BigInt(schemaVersion), true);
  const body = new Uint8Array(serialize(payload));
  const bytes = new Uint8Array(header.byteLength + body.byteLength);
  bytes.set(header, 0);
  bytes.set(body, header.byteLength);
  const cachePath = appToolingCompilationCachePath(cacheRoot, root);
  await mkdir(dirname(cachePath), { recursive: true });
  await writeFile(cachePath, bytes);
};

/** Shape `routeResolvedTooling` switches on before calling `runDynamicTooling`. */
const assertDynamicToolingRoute = (
  route: ToolingRoute,
  name: string,
  extra: { readonly input?: CommandIndexEntry["input"] } = {},
): void => {
  expect(route).toMatchObject({
    _tag: "tooling",
    commandId: `app:${name}`,
    name,
    hidden: false,
    ...extra,
  });
};

const declaredInput = Result.getOrThrowWith(
  normalizeToolingInput("greet", {
    flags: { name: { alias: "n", default: "world", description: "Who to greet" } },
    args: { target: { order: 0, required: true, choices: ["dev", "prod"], description: "Environment" } },
  }),
  (error) => error,
);

const declaredInputRoute = (
  overrides: Partial<Extract<ToolingRoute, { readonly _tag: "tooling" }>> = {},
): Extract<ToolingRoute, { readonly _tag: "tooling" }> => ({
  _tag: "tooling",
  commandId: "app:greet",
  name: "greet",
  summary: "Greet a target",
  hidden: false,
  input: declaredInput,
  ...overrides,
});

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
      hidden: false,
      summary: "Run quality checks",
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

    // Then — `_tag: "tooling"` is the branch `routeResolvedTooling` takes into `runDynamicTooling` → `runTooling`
    assertDynamicToolingRoute(route, "quality");
    expect(argv.slice(1)).toEqual(["--fix"]);
  });
});

test("Given a schema-version-2 cache blob, when resolving a listed task, then it is a cache-miss not an exception", async () => {
  await withApp(async (root, cacheRoot) => {
    // Given — prior index generation still lists the task; current schema is newer
    expect(Number(COMMAND_INDEX_SCHEMA_VERSION)).toBeGreaterThan(2);
    await writeSchemaV2CacheBlob(root, cacheRoot, [
      { id: "app:quality", summary: "Run quality checks", hidden: false },
    ]);

    // When
    const route = await Effect.runPromise(resolveToolingRoute("quality", { cwd: root, cacheRoot }));

    // Then — mismatch is a clean miss (never a thrown decode error, never a usable hit)
    expect(route).toEqual({
      _tag: "cache-miss",
      commandId: "app:quality",
      name: "quality",
      reason: "invalid-cache",
      sourcePath: join(root, ".lando.yml"),
      remediation: expect.stringContaining("lando app:cache:refresh"),
    });
  });
});

test("Given a fresh cache that does not list a token, when resolving it, then it is unknown-tooling", async () => {
  await withApp(async (root, cacheRoot) => {
    // Given
    await writeFreshCache(root, cacheRoot, [{ id: "app:cached", summary: "Cached task", hidden: false }]);

    // When
    const route = await Effect.runPromise(resolveToolingRoute("disabled-now", { cwd: root, cacheRoot }));

    // Then
    expect(route).toEqual({
      _tag: "unknown-tooling",
      commandId: "app:disabled-now",
      name: "disabled-now",
      remediation: expect.stringContaining("lando help"),
    });
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
    assertDynamicToolingRoute(route, "quality");
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
      remediation: expect.stringContaining("lando help"),
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

test("Given a cached task that declares input, when resolving any of its spellings, then each route carries the declared metadata", async () => {
  await withApp(async (root, cacheRoot) => {
    // Given — one declared-input task reachable by bare name, canonical id, and a custom alias
    await writeFreshCache(
      root,
      cacheRoot,
      [{ id: "app:greet", summary: "Greet a target", hidden: false, input: declaredInput }],
      {
        yaml: ["name: router-test", "commandAliases:", "  custom:", "    hi: app:greet", ""].join("\n"),
        landofile: { name: "router-test", commandAliases: { custom: { hi: "app:greet" } } },
      },
    );

    // When
    const [bare, canonical, aliased] = await Promise.all([
      Effect.runPromise(resolveToolingRoute("greet", { cwd: root, cacheRoot })),
      Effect.runPromise(resolveToolingRoute("app:greet", { cwd: root, cacheRoot })),
      Effect.runPromise(resolveToolingRoute("hi", { cwd: root, cacheRoot })),
    ]);

    // Then — help interception reads this metadata, so every route site must carry it
    assertDynamicToolingRoute(bare, "greet", { input: declaredInput });
    assertDynamicToolingRoute(canonical, "greet", { input: declaredInput });
    assertDynamicToolingRoute(aliased, "greet", { input: declaredInput });
  });
});

test("Given a cached task the index hides, when resolving it, then the route reports it hidden", async () => {
  await withApp(async (root, cacheRoot) => {
    // Given — a disabled task stays indexed as hidden so the authoritative check can refuse it
    await writeFreshCache(root, cacheRoot, [
      { id: "app:legacy", summary: "Retired task", hidden: true, input: declaredInput },
    ]);

    // When
    const route = await Effect.runPromise(resolveToolingRoute("legacy", { cwd: root, cacheRoot }));

    // Then
    expect(route).toEqual({
      _tag: "tooling",
      commandId: "app:legacy",
      name: "legacy",
      summary: "Retired task",
      hidden: true,
      sourcePath: join(root, ".lando.yml"),
      input: declaredInput,
    });
  });
});

test("Given a declared-input task, when its argv asks for help, then help is requested", () => {
  // Given
  const route = declaredInputRoute();

  // When
  const requests = [["--help"], ["-h"], ["dev", "--help"], ["--name=team", "-h"]].map((argv) =>
    toolingHelpRequested(route, argv),
  );

  // Then
  expect(requests).toEqual([true, true, true, true]);
});

test("Given a declared-input task, when argv has no help option, then help is not requested", () => {
  // Given
  const route = declaredInputRoute();

  // When
  const requests = [[], ["dev"], ["--name=team"], ["--helpless"]].map((argv) =>
    toolingHelpRequested(route, argv),
  );

  // Then
  expect(requests).toEqual([false, false, false, false]);
});

test("Given a declared-input task, when help follows the argument terminator, then it belongs to the task", () => {
  // Given
  const route = declaredInputRoute();

  // When
  const requests = [
    ["--", "--help"],
    ["dev", "--", "-h"],
  ].map((argv) => toolingHelpRequested(route, argv));

  // Then
  expect(requests).toEqual([false, false]);
});

test("Given a task with no declared input, when argv asks for help, then the option passes through to the command", () => {
  // Given — raw argv passthrough is what lets `lando composer --help` show the tool's own help
  const { input: _input, ...route } = declaredInputRoute();

  // When
  const requested = toolingHelpRequested(route, ["--help"]);

  // Then
  expect(requested).toBe(false);
});

test("Given a hidden declared-input task, when argv asks for help, then it routes to pre-execution refusal", () => {
  // Given — a disabled task is indexed hidden and must still fail with its tagged error
  const route = declaredInputRoute({ hidden: true });

  // When
  const requested = toolingHelpRequested(route, ["--help"]);

  // Then
  expect(requested).toBe(true);
});

test("Given a task that declares its own help flag, when argv asks for help, then the declared flag wins", () => {
  // Given
  const byName = declaredInputRoute({
    input: Result.getOrThrowWith(
      normalizeToolingInput("greet", { flags: { help: { boolean: true } } }),
      (error) => error,
    ),
  });
  const byAlias = declaredInputRoute({
    input: Result.getOrThrowWith(
      normalizeToolingInput("greet", { flags: { hint: { alias: "h", boolean: true } } }),
      (error) => error,
    ),
  });

  // When
  const requests = [toolingHelpRequested(byName, ["--help"]), toolingHelpRequested(byAlias, ["-h"])];

  // Then
  expect(requests).toEqual([false, false]);
});

test("Given a route that is not a normalized tooling task, when argv asks for help, then no help is requested", () => {
  // Given
  const routes: ReadonlyArray<ToolingRoute> = [
    { _tag: "not-tooling" },
    {
      _tag: "bun-script",
      commandId: "app:quality",
      name: "quality",
      summary: "",
      hidden: false,
      appRoot: "/tmp",
    },
    { _tag: "unknown-tooling", commandId: "app:nope", name: "nope", remediation: "refresh" },
  ];

  // When
  const requests = routes.map((route) => toolingHelpRequested(route, ["--help"]));

  // Then
  expect(requests).toEqual([false, false, false]);
});

const countingCatalog = () => {
  const state = { acquired: 0 };
  const id = "fx:inspect";
  const commands = [
    {
      id,
      pluginName: "@example/fx",
      source: "explicit" as const,
      descriptor: { id, summary: "Inspect fixture.", topLevelAlias: "inspect" },
      load: async () => ({
        id,
        namespace: "fx",
        bootstrap: "plugins" as const,
        resultSchema: Schema.String,
        run: () => Effect.succeed(id),
      }),
    },
  ];
  const catalog = createPluginCommandCatalog(undefined, () =>
    Effect.sync(() => {
      state.acquired += 1;
      return {
        plugins: [],
        globalPlugins: [],
        commands,
        certificateAuthorities: [],
        hostContext: Context.empty(),
      };
    }),
  );
  return { state, catalog };
};

test("a fresh-cache built-in alias routes without acquiring plugin metadata", async () => {
  await withApp(async (root, cacheRoot) => {
    // Given a fresh app command index and an invocation catalog
    await writeFreshCache(root, cacheRoot, []);
    const { state, catalog } = countingCatalog();
    // When the built-in alias is routed
    const route = await Effect.runPromise(resolveToolingRoute("start", { cwd: root, cacheRoot, catalog }));
    // Then it resolves to the built-in and plugin metadata stays unacquired
    expect(route).toMatchObject({ _tag: "built-in", commandId: "app:start" });
    expect(state.acquired).toBe(0);
  });
});

test("plugin alias routing reuses the invocation catalog", async () => {
  await withApp(async (root, cacheRoot) => {
    // Given a fresh app command index and an invocation catalog that owns a plugin alias
    await writeFreshCache(root, cacheRoot, []);
    const { state, catalog } = countingCatalog();
    // When the alias is routed twice
    const routes = [
      await Effect.runPromise(resolveToolingRoute("inspect", { cwd: root, cacheRoot, catalog })),
      await Effect.runPromise(resolveToolingRoute("inspect", { cwd: root, cacheRoot, catalog })),
    ];
    // Then both resolve through the supplied catalog's single acquisition
    expect(routes).toEqual([
      { _tag: "plugin", commandId: "fx:inspect", token: "inspect" },
      { _tag: "plugin", commandId: "fx:inspect", token: "inspect" },
    ]);
    expect(state.acquired).toBe(1);
  });
});
