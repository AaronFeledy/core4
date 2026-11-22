import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { writeAppCommandCacheStrict } from "@lando/engine/cache/command-index-writer";
import { appToolingCompilationCachePath } from "@lando/engine/cache/paths";
import { normalizeToolingInput } from "@lando/landofile/tooling-input-normalize";
import { createBufferedRendererIO } from "@lando/renderer/io";
import { AppPlanner, CommandRegistry, RuntimeProviderRegistry } from "@lando/sdk/services";
import { makeTestRuntimeProviderRegistry } from "@lando/sdk/test";
import { Effect, Result, Schema } from "effect";
import { renderColdAllHelp, renderColdRootHelp } from "../../src/cli/cold-path-output.ts";
import { HelpCatalogResult, buildHelpCatalog } from "../../src/cli/compiled-help.ts";
import { splitCommandTokens } from "../../src/cli/invocation.ts";
import { ownerPolicy } from "../../src/cli/invocation-owner.ts";
import { renderPreCommandFailure } from "../../src/cli/spec/command-boundary.ts";
import { toolingMetadataStatus } from "../../src/cli/tooling-cache-status.ts";
import { readCliAppCommandCache } from "../../src/cli/tooling-command-cache.ts";
import { type ToolingRoute, resolveToolingRoute, toolingRouteFailure } from "../../src/cli/tooling-router.ts";
import { CliInvocation } from "../../src/runtime/invocation-context.ts";

test.each([
  {
    description: "single catalog owner",
    services: "  web:\n    type: node:22",
    expected: [
      ["npm", "web"],
      ["npx", "web"],
    ],
  },
  {
    description: "two npm owners",
    services: "  web:\n    type: node:22\n  api:\n    type: node:24",
    expected: [],
  },
  { description: "bun pin", services: "  web:\n    type: node:22", pin: "bun@1.3.1", expected: [] },
  {
    description: "replacement image",
    services: "  web:\n    type: node:22\n    image: custom:1",
    expected: [],
  },
  {
    description: "replacement build",
    services: "  web:\n    type: node:22\n    build:\n      context: .",
    expected: [],
  },
  {
    description: "Landofile override and disable",
    services: "  web:\n    type: node:22\n  api:\n    type: node:24\n    image: custom:1",
    tooling: "\ntooling:\n  npm:\n    service: api\n    cmd: alternate\n  npx: false",
    expected: [
      ["npm", "api"],
      ["npx", "disabled"],
    ],
  },
])("publishes manager tasks for $description", async ({ services, tooling, pin, expected }) => {
  const cwd = await mkdtemp(join(tmpdir(), "lando-node-manager-owners-"));
  const cacheRoot = join(cwd, "cache");
  const env = {
    ...process.env,
    LANDO_USER_CACHE_ROOT: cacheRoot,
    LANDO_USER_DATA_ROOT: join(cwd, "data"),
    LANDO_USER_CONF_ROOT: join(cwd, "conf"),
  };
  try {
    await writeFile(
      join(cwd, ".lando.yml"),
      `name: manager-owners\nservices:\n${services}${tooling ?? ""}\n`,
    );
    if (pin !== undefined)
      await writeFile(join(cwd, "package.json"), JSON.stringify({ packageManager: pin }));
    const result = await Effect.runPromise(
      readCliAppCommandCache({ cwd, cacheRoot, rebuildNotice: false }).pipe(
        Effect.provideService(CliInvocation, {
          cwd,
          env,
          io: createBufferedRendererIO(),
          setExitCode: () => undefined,
        }),
      ),
    );
    if (result.status !== "fresh")
      throw new Error(`Expected fresh command metadata: ${JSON.stringify(result)}`);
    expect(
      result.payload.entries.map((entry) => [
        entry.id.replace(/^app:/, ""),
        entry._tag === "Ready" ? entry.service : entry._tag === "Disabled" ? "disabled" : "unavailable",
      ]),
    ).toEqual(expected.map((entry) => [...entry]));
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test.each(["manifest edit", "new nested candidate", "oversize", "symlink"])(
  "refreshes Node command discovery after %s",
  async (change) => {
    const cwd = await mkdtemp(join(tmpdir(), "lando-node-command-index-"));
    const manifest = join(cwd, "package.json");
    const env = {
      ...process.env,
      LANDO_USER_CACHE_ROOT: join(cwd, "cache"),
      LANDO_USER_DATA_ROOT: join(cwd, "data"),
      LANDO_USER_CONF_ROOT: join(cwd, "conf"),
    };
    const help = async (name: string) => {
      const child = Bun.spawn(
        [process.execPath, join(import.meta.dirname, "../../bin/lando.ts"), "help", name, "--format=json"],
        { cwd, env, stdout: "pipe", stderr: "pipe" },
      );
      const [stdout, stderr, exit] = await Promise.all([
        child.stdout.text(),
        child.stderr.text(),
        child.exited,
      ]);
      return { stdout, stderr, exit };
    };
    try {
      await mkdir(join(cwd, "web"));
      await writeFile(
        join(cwd, ".lando.yml"),
        "name: node-index\nservices:\n  web:\n    type: node:22\n    packageRoot: web\n",
      );
      const old = '{"packageManager":"npm@10.10.0"} ';
      const next = '{"packageManager":"pnpm@10.10.0"}';
      await writeFile(manifest, old);
      expect((await help("npm")).exit).toBe(0);
      if (change === "manifest edit") await writeFile(manifest, next);
      if (change === "new nested candidate") await writeFile(join(cwd, "web", "package.json"), next);
      if (change === "oversize") await truncate(manifest, 2 ** 21);
      if (change === "symlink") {
        const target = join(cwd, "other.json");
        await writeFile(target, old);
        await rm(manifest);
        await symlink(target, manifest, "file");
      }
      if (change === "manifest edit" || change === "new nested candidate") {
        expect((await help("pnpm")).exit).toBe(0);
        expect((await help("npm")).stdout).toContain("UnknownCommandError");
      } else {
        const result = await help("npm");
        expect(result.exit).not.toBe(0);
        expect(result.stdout + result.stderr).toContain("LandofileValidationError");
      }
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  },
  15_000,
);

const helpRequested = (route: ToolingRoute, argv: ReadonlyArray<string>): boolean => {
  switch (route._tag) {
    case "tooling":
    case "bun-script":
      return splitCommandTokens(argv, ownerPolicy({ kind: "tooling", route })).help;
    case "built-in":
    case "plugin":
    case "not-tooling":
    case "alias-disabled":
    case "cache-miss":
    case "unknown-tooling":
      return false;
    default:
      return route satisfies never;
  }
};

const states = ["missing", "stale", "invalid", "unknown"] as const;
type State = (typeof states)[number];
// Every non-fresh index rebuilds; the unparseable Landofile makes that rebuild fail, so the
// rebuild's own error (not a cache-state error) proves the rebuild ran.
const failures = {
  missing: { _tag: "LandofileParseError" },
  stale: { _tag: "LandofileParseError" },
  invalid: { _tag: "LandofileParseError" },
  // A fresh index that lacks the task is an ordinary unknown command.
  unknown: { _tag: "UnknownCommandError", commandToken: "app:absent" },
} as const;
const failureCommand = (state: State) => (state === "unknown" ? "cli:unknown-command" : "app:absent");

test.each([
  { acceptsArguments: true, wrapper: true, expected: false },
  { acceptsArguments: true, wrapper: false, expected: true },
  { acceptsArguments: false, wrapper: false, expected: true },
])(
  "routes help for empty declarations by wrapper policy ($acceptsArguments, wrapper=$wrapper)",
  ({ acceptsArguments, wrapper, expected }) => {
    // Given
    const input = Result.getOrThrowWith(
      normalizeToolingInput("empty", acceptsArguments ? {} : { arguments: false }),
      (error) => error,
    );
    // When
    const requested = helpRequested(
      {
        _tag: "tooling",
        commandId: "app:empty",
        name: "empty",
        summary: "",
        hidden: false,
        availability: { _tag: "Ready", input, ...(wrapper ? { wrapper: true as const } : {}) },
      },
      ["--help"],
    );
    // Then
    expect(requested).toBe(expected);
  },
);

const withCache = async (
  state: State,
  run: (cwd: string, cacheRoot: string) => Promise<void>,
  childEnvironment = false,
) => {
  const cwd = await mkdtemp(join(tmpdir(), "lando-tooling-recovery-"));
  const cacheRoot = join(cwd, "cache");
  try {
    await writeFile(join(cwd, ".lando.yml"), "name: [unparseable\n");
    if (state !== "missing")
      await Effect.runPromise(
        writeAppCommandCacheStrict({
          cwd,
          cacheRoot,
          ...(childEnvironment
            ? {
                env: {
                  ...process.env,
                  LANDO_USER_CACHE_ROOT: cacheRoot,
                  LANDO_USER_DATA_ROOT: join(cwd, "data"),
                  LANDO_USER_CONF_ROOT: join(cwd, "conf"),
                },
              }
            : {}),
          landofile: { name: "recovery" },
          entries: [
            {
              id: "app:known",
              summary: "Old metadata must not leak",
              _tag: "Ready",
              sourceKind: "tooling",
              visibility: "public",
              input: Result.getOrThrowWith(
                normalizeToolingInput("known", { flags: { credential: { sensitive: true } } }),
                (error) => error,
              ),
            },
          ],
        }),
      );
    if (state === "stale") await writeFile(join(cwd, ".lando.yml"), "name: [changed\n");
    if (state === "invalid") {
      const cachePath = appToolingCompilationCachePath(cacheRoot, cwd);
      await mkdir(dirname(cachePath), { recursive: true });
      await writeFile(cachePath, "invalid cache");
    }
    await run(cwd, cacheRoot);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
};

test.each(["missing", "stale", "invalid"] as const)(
  "renders %s recovery without using caller-provided services",
  async (state) => {
    await withCache(state, async (cwd, cacheRoot) => {
      // Given
      const calls = { plan: 0, provider: 0, registry: 0 };
      const blocked = (key: keyof typeof calls) =>
        Effect.sync((): never => {
          calls[key]++;
          throw new TypeError(`Unexpected live ${key} call`);
        });
      const route = await Effect.runPromise(
        resolveToolingRoute("absent", { cwd, cacheRoot }).pipe(
          Effect.provideService(AppPlanner, { plan: () => blocked("plan") }),
          Effect.provideService(CommandRegistry, { list: blocked("registry") }),
          Effect.provideService(
            RuntimeProviderRegistry,
            makeTestRuntimeProviderRegistry({
              list: blocked("provider"),
              capabilities: blocked("provider"),
              appliedPlansFor: () => blocked("provider"),
              select: () => blocked("provider"),
              resolveAppliedPlan: () => blocked("provider"),
              resolveTeardownEvidence: () => blocked("provider"),
            }),
          ),
        ),
      );
      if (route._tag !== "cache-miss") throw new TypeError(`Unexpected route ${route._tag}`);
      const error = toolingRouteFailure(route);
      const io = createBufferedRendererIO();
      let exitCode = 0;
      // When
      await renderPreCommandFailure({
        commandId: route.commandId,
        error,
        rendererMode: "json",
        resultFormat: "json",
        io,
        setExitCode: (code) => {
          exitCode = code;
        },
      });
      // Then
      expect(exitCode).toBe(1);
      expect(JSON.parse(io.stdout())).toMatchObject({
        ok: false,
        command: "app:absent",
        error: failures[state],
      });
      expect(calls).toEqual({ plan: 0, provider: 0, registry: 0 });
      expect(io.stdout()).not.toContain("credential");
      expect(io.stdout()).not.toContain("app:cache:refresh");
    });
  },
);

test.each(states)("keeps built-ins available and reflects %s metadata in root help", async (state) => {
  await withCache(state, async (cwd, cacheRoot) => {
    // Given
    const receipt = await Effect.runPromise(readCliAppCommandCache({ cwd, cacheRoot, rebuildNotice: false }));
    const metadata = toolingMetadataStatus(receipt);
    const cache = receipt.status === "fresh" ? receipt.payload : null;
    // When
    const catalog = buildHelpCatalog(cache, metadata);
    const root = renderColdRootHelp(undefined, { style: false, toolingMetadata: metadata });
    const all = renderColdAllHelp({ style: false, toolingMetadata: metadata });
    // Then
    expect(Schema.is(HelpCatalogResult)(catalog)).toBe(true);
    expect(catalog.all.some((row) => row.canonicalId === "app:start")).toBe(true);
    expect(catalog.sections.thisApp.length).toBe(state === "unknown" ? 1 : 0);
    expect(catalog.toolingMetadata).toMatchObject(
      state === "unknown"
        ? { status: "fresh" }
        : { status: "unavailable", reason: "rebuild-failed", error: { _tag: "LandofileParseError" } },
    );
    for (const text of [root, all]) {
      expect(text).toContain("app:start");
      expect(text).not.toContain("credential");
      expect(text.includes("This app's commands are unavailable: ")).toBe(state !== "unknown");
    }
  });
});

test.each(states)("direct help adapter reports the %s lookup failure", async (state) => {
  await withCache(
    state,
    async (cwd, cacheRoot) => {
      // Given
      const runtime = pathToFileURL(join(import.meta.dirname, "../../src/cli/compiled-runtime.ts")).href;
      const help = pathToFileURL(join(import.meta.dirname, "../../src/cli/run-help.ts")).href;
      const program = `import { setActiveRendererMode, setActiveResultFormat } from ${JSON.stringify(runtime)};
      import { dispatchHelpTarget } from ${JSON.stringify(help)};
      setActiveRendererMode("json"); setActiveResultFormat("json"); await dispatchHelpTarget("app:absent");`;
      // When
      const child = Bun.spawn([process.execPath, "-e", program], {
        cwd,
        stdout: "pipe",
        stderr: "pipe",
        env: {
          ...process.env,
          LANDO_USER_CACHE_ROOT: cacheRoot,
          LANDO_USER_DATA_ROOT: join(cwd, "data"),
          LANDO_USER_CONF_ROOT: join(cwd, "conf"),
        },
      });
      const [code, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      // Then
      expect(code, stderr).toBe(state === "unknown" ? 2 : 1);
      expect(JSON.parse(stdout)).toMatchObject({
        ok: false,
        command: failureCommand(state),
        error: { ...failures[state], remediation: expect.stringMatching(/\S/u) },
      });
      expect(stderr).toBe("");
    },
    true,
  );
});
