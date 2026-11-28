import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeLandoRuntime } from "@lando/core";
import { AbsolutePath, type AppPlan, ProviderId } from "@lando/core/schema";
import {
  AppPlanner,
  LandofileService,
  RouterService,
  RuntimeProvider,
  RuntimeProviderRegistry,
} from "@lando/core/services";
import { compileInspectedAppCommands } from "@lando/engine/cache/command-compiler";
import { loadUserLandofileAt } from "@lando/engine/landofile/app-resolution";
import { inspectBunShellScripts } from "@lando/landofile/bun-sh-discovery";
import { type McpDispatchDeps, dispatchTool } from "@lando/mcp/dispatch";
import { makeNestedExecute } from "@lando/mcp/execute";
import type { McpCommandEntry } from "@lando/mcp/registry";
import { resolveCommandCompletion } from "@lando/sdk/command-result";
import { createRedactor } from "@lando/sdk/secrets";
import { TestRouterService, TestRuntimeProvider, makeTestRuntimeProviderRegistry } from "@lando/sdk/test";
import { Context, Effect, Layer } from "effect";
import { mcpRegistryWithToolingEntries } from "../../src/cli/commands/meta/mcp.ts";
import { withCwd, withEnvVar } from "../_support/temp-cwd.ts";

const script = [
  "# ---",
  "# env:",
  '#   SITE: "{{ services.web.url }}"',
  "# ---",
  'echo "site=[$SITE]"',
  "",
].join("\n");

const landofile = [
  "name: called-app",
  "services:",
  "  web:",
  "    image: node:lts",
  "    primary: true",
  "    routes:",
  "      - hostname: called-app.lndo.site",
  "        scheme: https",
  "",
].join("\n");

const withApps = async (run: (session: string, called: string) => Promise<void>) => {
  const root = await mkdtemp(join(tmpdir(), "lando-mcp-route-facts-"));
  const session = join(root, "session");
  const called = join(root, "called");
  try {
    await mkdir(join(session), { recursive: true });
    await mkdir(join(called, ".lando/scripts"), { recursive: true });
    await writeFile(join(session, ".lando.yml"), "name: session-app\n");
    await writeFile(join(called, ".lando.yml"), landofile);
    await writeFile(join(called, ".lando/scripts/smoke.bun.sh"), script);
    await run(session, called);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
};

const project = async (root: string): Promise<McpCommandEntry> => {
  const registry = mcpRegistryWithToolingEntries(
    { commandEntries: [] },
    compileInspectedAppCommands({
      sourcePath: root,
      landofile: {},
      inspection: await Effect.runPromise(inspectBunShellScripts({ appRoot: root })),
      redact: createRedactor("secrets").redactString,
    }),
  );
  const entry = registry.toolingEntries?.[0];
  if (entry === undefined) throw new Error("missing script projection");
  return entry;
};

test("an MCP tool call for another app resolves that app's script route fact", async () => {
  await withApps(async (session, called) => {
    // Given a retained app-tier runtime built for the session app and a script owned by another app
    const entry = await project(called);
    const frames: string[] = [];
    let applied: AppPlan | undefined;
    const result = await withCwd(session, () =>
      withEnvVar("LANDO_PROVIDER", TestRuntimeProvider.id, () =>
        Effect.runPromise(
          Effect.gen(function* () {
            const context = yield* Layer.build(
              makeLandoRuntime({
                bootstrap: "app",
                cwd: session,
                plugins: {
                  policy: "bundled-only",
                  layers: [
                    Layer.succeed(RuntimeProvider, RuntimeProvider.of(TestRuntimeProvider)),
                    Layer.succeed(
                      RuntimeProviderRegistry,
                      makeTestRuntimeProviderRegistry({
                        list: Effect.succeed([ProviderId.make(TestRuntimeProvider.id)]),
                        readAppliedPlanStrict: () => Effect.succeed(applied),
                      }),
                    ),
                    Layer.succeed(
                      RouterService,
                      RouterService.of({
                        ...TestRouterService,
                        routeAuthorities: (routes) =>
                          Effect.succeed(
                            routes.flatMap((route) =>
                              (route.scheme === "both" ? (["http", "https"] as const) : [route.scheme]).map(
                                (scheme) => ({
                                  hostname: route.hostname,
                                  scheme,
                                  port: scheme === "https" ? 8443 : 8080,
                                }),
                              ),
                            ),
                          ),
                      }),
                    ),
                  ],
                },
              }),
            );
            // The called app's plan is what the retained runtime records as applied for it.
            const planner = Context.get(context, AppPlanner);
            const registryService = Context.get(context, RuntimeProviderRegistry);
            const landofile = yield* loadUserLandofileAt(
              Context.get(context, LandofileService),
              AbsolutePath.make(called),
            );
            applied = yield* planner.plan(landofile, yield* registryService.capabilities);
            const redactor = createRedactor("secrets");
            const deps: McpDispatchDeps = {
              registry: new Map([[entry.spec.id, entry]]),
              effective: new Set([entry.spec.id]),
              allowlistSource: "tooling",
              redactor,
              resultRedactor: () => Effect.succeed(redactor),
              execute: makeNestedExecute(
                Context.makeUnsafe<unknown>(context.mapUnsafe),
                {
                  sink: {
                    emit: (frame) =>
                      Effect.sync(() => {
                        if (frame._tag !== "stdout") return;
                        frames.push(
                          typeof frame.chunk === "string"
                            ? frame.chunk
                            : new TextDecoder().decode(frame.chunk),
                        );
                      }),
                  },
                  finish: () => Effect.void,
                },
                {
                  execute: (command) =>
                    Effect.exit(
                      Effect.map(command, (value) => resolveCommandCompletion(entry.spec.id, value)),
                    ),
                },
              ),
            };
            return yield* dispatchTool({ toolId: entry.spec.id, input: { appPath: called } }, deps);
          }).pipe(Effect.scoped),
        ),
      ),
    );
    // Then the script receives the called app's published URL, not the session directory's
    expect(result.envelope).toMatchObject({ ok: true, result: { exitCode: 0 } });
    expect(frames.join("")).toBe("site=[https://called-app.lndo.site:8443]\n");
  });
});
