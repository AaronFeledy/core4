import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  readAppCommandCacheForCwdDetailed,
  writeAppCommandCacheStrict,
} from "@lando/engine/cache/command-index-writer";
import { appToolingCompilationCachePath } from "@lando/engine/cache/paths";
import { normalizeToolingInput } from "@lando/landofile/tooling-input-normalize";
import { createBufferedRendererIO } from "@lando/renderer/io";
import { AppPlanner, CommandRegistry, RuntimeProviderRegistry } from "@lando/sdk/services";
import { Effect, Result, Schema } from "effect";
import { renderColdAllHelp, renderColdRootHelp } from "../../src/cli/cold-path-output.ts";
import { HelpCatalogResult, buildHelpCatalog } from "../../src/cli/compiled-help.ts";
import { renderPreCommandFailure } from "../../src/cli/spec/command-boundary.ts";
import { toolingMetadataStatus } from "../../src/cli/tooling-cache-status.ts";
import {
  resolveToolingRoute,
  toolingHelpRequested,
  toolingRouteError,
} from "../../src/cli/tooling-router.ts";

const states = ["missing", "stale", "invalid", "unknown"] as const;
type State = (typeof states)[number];
const reasons = {
  missing: "missing-cache",
  stale: "stale-cache",
  invalid: "invalid-cache",
  unknown: "unknown-command",
} as const;

test.each([true, false])(
  "uses argument policy for empty declarations (acceptsArguments=%s)",
  (acceptsArguments) => {
    // Given
    const input = Result.getOrThrowWith(
      normalizeToolingInput("empty", acceptsArguments ? {} : { arguments: false }),
      (error) => error,
    );
    // When
    const requested = toolingHelpRequested(
      { _tag: "tooling", commandId: "app:empty", name: "empty", summary: "", hidden: false, input },
      ["--help"],
    );
    // Then
    expect(requested).toBe(!acceptsArguments);
  },
);

const withCache = async (state: State, run: (cwd: string, cacheRoot: string) => Promise<void>) => {
  const cwd = await mkdtemp(join(tmpdir(), "lando-tooling-recovery-"));
  const cacheRoot = join(cwd, "cache");
  try {
    await writeFile(join(cwd, ".lando.yml"), "name: [unparseable\n");
    if (state !== "missing")
      await Effect.runPromise(
        writeAppCommandCacheStrict({
          cwd,
          cacheRoot,
          landofile: { name: "recovery" },
          entries: [
            {
              id: "app:known",
              summary: "Old metadata must not leak",
              hidden: false,
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

test.each(states)(
  "renders %s recovery with structural machine fields and zero live services",
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
          Effect.provideService(RuntimeProviderRegistry, {
            list: blocked("provider"),
            capabilities: blocked("provider"),
            appliedPlansFor: () => blocked("provider"),
            select: () => blocked("provider"),
            resolveAppliedPlan: () => blocked("provider"),
            resolveTeardownEvidence: () => blocked("provider"),
          }),
        ),
      );
      if (route._tag !== "cache-miss" && route._tag !== "unknown-tooling")
        throw new TypeError(`Unexpected route ${route._tag}`);
      const error = toolingRouteError(route);
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
        error: {
          _tag: "ToolingCommandUnavailableError",
          reason: reasons[state],
          commandId: "app:absent",
          tool: "absent",
          ...(state === "stale" ? { staleReason: "source" } : {}),
        },
      });
      expect(calls).toEqual({ plan: 0, provider: 0, registry: 0 });
      expect(io.stdout()).not.toContain("credential");
      expect(error.remediation.includes("app:cache:refresh")).toBe(state !== "unknown");
    });
  },
);

test.each(states)(
  "keeps built-ins available and omits unavailable schemas in %s root help",
  async (state) => {
    await withCache(state, async (cwd, cacheRoot) => {
      // Given
      const receipt = await Effect.runPromise(readAppCommandCacheForCwdDetailed({ cwd, cacheRoot }));
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
        state === "unknown" ? { status: "fresh" } : { status: "unavailable", reason: reasons[state] },
      );
      for (const text of [root, all]) {
        expect(text).toContain("app:start");
        expect(text).not.toContain("credential");
        if (state !== "unknown") expect(text).toContain(reasons[state]);
      }
    });
  },
);

test.each(states)("direct help adapter emits actionable %s recovery without executing", async (state) => {
  await withCache(state, async (cwd, cacheRoot) => {
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
    expect(code, stderr).toBe(1);
    expect(JSON.parse(stdout)).toMatchObject({
      ok: false,
      command: "app:absent",
      error: { _tag: "ToolingCommandUnavailableError", reason: reasons[state] },
    });
    expect(stderr).toBe("");
  });
});
