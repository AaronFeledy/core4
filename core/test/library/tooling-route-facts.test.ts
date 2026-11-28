import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeLandoRuntime, resolveApp } from "@lando/core";
import { AbsolutePath, type AppPlan, ProviderId } from "@lando/core/schema";
import { RouterService, RuntimeProvider, RuntimeProviderRegistry } from "@lando/core/services";
import { TestRouterService, TestRuntimeProvider, makeTestRuntimeProviderRegistry } from "@lando/sdk/test";
import { Effect, Layer } from "effect";
import { withEnvVar } from "../_support/temp-cwd.ts";

test("an embedded app.tooling call resolves a script's route facts from the app plan", async () => {
  const root = await mkdtemp(join(tmpdir(), "lando-library-route-facts-"));
  try {
    await mkdir(join(root, ".lando/scripts"), { recursive: true });
    await writeFile(
      join(root, ".lando.yml"),
      [
        "name: library-route-facts",
        `provider: ${TestRuntimeProvider.id}`,
        "services:",
        "  web:",
        "    image: node:lts",
        "    primary: true",
        "    routes:",
        "      - hostname: library-route-facts.lndo.site",
        "        scheme: https",
        "",
      ].join("\n"),
    );
    await writeFile(
      join(root, ".lando/scripts/smoke.bun.sh"),
      ["# ---", "# env:", '#   SITE: "{{ services.web.url }}"', "# ---", 'printf "%s" "$SITE"', ""].join(
        "\n",
      ),
    );
    let applied: AppPlan | undefined;
    const result = await withEnvVar("LANDO_PROVIDER", TestRuntimeProvider.id, () =>
      Effect.runPromise(
        Effect.gen(function* () {
          const layer = makeLandoRuntime({
            bootstrap: "app",
            cwd: root,
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
                        routes.flatMap((entry) =>
                          (entry.scheme === "both" ? (["http", "https"] as const) : [entry.scheme]).map(
                            (scheme) => ({
                              hostname: entry.hostname,
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
          });
          return yield* Effect.gen(function* () {
            const app = yield* resolveApp({ root: AbsolutePath.make(root) });
            applied = yield* app.plan;
            return yield* app.tooling("smoke");
          }).pipe(Effect.provide(layer), Effect.scoped);
        }),
      ),
    );
    expect(result).toMatchObject({
      tool: "app:smoke",
      exitCode: 0,
      stdout: "https://library-route-facts.lndo.site:8443",
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
