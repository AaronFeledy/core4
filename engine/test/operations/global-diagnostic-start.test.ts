import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";

import { runServiceStartSchedule } from "@lando/container-runtime/service-start-schedule";
import { ProviderUnavailableError } from "@lando/sdk/errors";
import { AbsolutePath, AppId, type AppPlan, ServiceName } from "@lando/sdk/schema";
import {
  AppPlanner,
  BuildOrchestrator,
  GlobalAppService,
  RouterService,
  RuntimeProviderRegistry,
} from "@lando/sdk/services";
import { TestRouterService, TestRuntimeProvider } from "@lando/sdk/test";

import { startApp } from "../../src/operations/start.ts";
import { makeHarness, plan, web } from "./start-progress-topology-support.ts";

for (const failBuild of [false, true]) {
  test(`cold start restores persisted fallback backend before ${failBuild ? "a failed" : "a successful"} app build`, async () => {
    const directory = await mkdtemp(join(tmpdir(), "lando-global-start-"));
    const root = AbsolutePath.make(directory);
    const distLandofile = AbsolutePath.make(join(directory, ".lando.dist.yml"));
    const userLandofile = AbsolutePath.make(join(directory, ".lando.yml"));
    const fallback = join(directory, "fallback.yml");
    const diagnostics = ServiceName.make("traefik-diagnostics");
    const traefik = ServiceName.make("traefik");
    const diagnosticService = {
      ...web,
      name: diagnostics,
      healthcheck: {
        kind: "command" as const,
        command: ["check-diagnostic"],
        intervalSeconds: 1,
        timeoutSeconds: 1,
        retries: 1,
      },
    };
    const globalPlan: AppPlan = {
      ...plan,
      id: AppId.make("global"),
      name: "global",
      root,
      services: {
        [traefik]: {
          ...web,
          name: traefik,
          dependsOn: [{ service: diagnostics, condition: "service_healthy", required: true }],
        },
        [diagnostics]: diagnosticService,
        [ServiceName.make("unrelated")]: { ...web, name: ServiceName.make("unrelated") },
      },
    };
    const appPlan: AppPlan = { ...plan, root, requires: { globalServices: ["traefik"] } };
    const running = new Set<string>();
    const steps: string[] = [];
    const provider = {
      ...TestRuntimeProvider,
      id: "lando",
      apply: (applied: AppPlan) =>
        applied.id === globalPlan.id
          ? runServiceStartSchedule(applied, {
              startService: (service) =>
                Effect.promise(async () => {
                  if (service.name === traefik) {
                    expect(await readFile(fallback, "utf8")).toContain("traefik-diagnostics");
                    expect(running.has(diagnostics)).toBe(true);
                  }
                  steps.push(`start:${service.name}`);
                  running.add(service.name);
                  return { changed: true };
                }),
              execHealthcheck: () =>
                Effect.sync(() => {
                  steps.push("healthy:diagnostics");
                  return { exitCode: running.has(diagnostics) ? 0 : 1 };
                }),
              waitForExit: () => Effect.succeed({ exitCode: 0 }),
            }).pipe(Effect.as({ changed: true }))
          : Effect.succeed({ changed: true }),
    };
    const globalApp: typeof GlobalAppService.Service = {
      id: "global",
      root: Effect.succeed(root),
      ensureRoot: Effect.void,
      paths: Effect.succeed({ root, distLandofile, userLandofile }),
      ensureUserLandofile: Effect.succeed({ path: userLandofile, created: false }),
      regenerateDist: () => Effect.succeed({ path: distLandofile, status: "unchanged", serviceIds: [] }),
      ensureRunning: () => Effect.die("router setup must not be needed to start the diagnostic backend"),
    };
    try {
      await writeFile(distLandofile, "name: global\nservices: {}\n");
      await writeFile(fallback, "service: traefik-diagnostics\n");
      const harness = makeHarness({ plannedApp: appPlan });
      const start = startApp({}, { plan: appPlan, root, app: { kind: "user", id: appPlan.id, root } }).pipe(
        Effect.provideService(GlobalAppService, globalApp),
        Effect.provideService(AppPlanner, { plan: () => Effect.succeed(globalPlan) }),
        Effect.provideService(RuntimeProviderRegistry, {
          list: Effect.succeed([plan.provider]),
          capabilities: Effect.succeed(provider.capabilities),
          select: () => Effect.succeed(provider),
        }),
        Effect.provideService(RouterService, {
          ...TestRouterService,
          setup: () =>
            Effect.sync(() => {
              steps.push("router:setup");
            }),
        }),
        Effect.provideService(BuildOrchestrator, {
          build: (built) =>
            built.id === globalPlan.id
              ? Effect.succeed(built)
              : Effect.gen(function* () {
                  steps.push("app:build");
                  expect(running.has(diagnostics)).toBe(true);
                  if (failBuild)
                    return yield* Effect.fail(
                      new ProviderUnavailableError({
                        message: "injected build failure",
                        providerId: "lando",
                        operation: "build",
                      }),
                    );
                  return built;
                }),
          buildApp: () => Effect.void,
        }),
        Effect.provide(harness.layer),
      );
      const result = await Effect.runPromiseExit(start);
      expect(result._tag).toBe(failBuild ? "Failure" : "Success");
      expect(steps.slice(0, 4)).toEqual([
        "start:traefik-diagnostics",
        "healthy:diagnostics",
        "start:traefik",
        "app:build",
      ]);
      expect(running.has(diagnostics)).toBe(true);
      expect(running.has("unrelated")).toBe(false);
      expect(await readFile(fallback, "utf8")).toContain("traefik-diagnostics");
      if (failBuild) expect(steps).not.toContain("router:setup");
      else {
        running.clear();
        steps.length = 0;
        expect((await Effect.runPromiseExit(start))._tag).toBe("Success");
        expect(steps.slice(0, 4)).toEqual([
          "start:traefik-diagnostics",
          "healthy:diagnostics",
          "start:traefik",
          "app:build",
        ]);
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
}
