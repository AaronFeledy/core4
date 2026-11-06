import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Cause, DateTime, Effect, Schema } from "effect";

import { runServiceStartSchedule } from "@lando/container-runtime/service-start-schedule";
import { ProviderUnavailableError } from "@lando/sdk/errors";
import {
  AbsolutePath,
  AppId,
  type AppPlan,
  PluginManifest,
  ServiceConfig,
  ServiceName,
  appIdentityKey,
} from "@lando/sdk/schema";
import {
  AppPlanner,
  BuildOrchestrator,
  GlobalAppService,
  PluginRegistry,
  RouterService,
  RuntimeProviderRegistry,
} from "@lando/sdk/services";
import { TestRouterService, TestRuntimeProvider } from "@lando/sdk/test";

import { renderGlobalDist } from "../../src/global-app/service.ts";
import { startApp } from "../../src/operations/start.ts";
import { makeHarness, plan, web } from "./start-progress-topology-support.ts";

for (const failBuild of [false, true]) {
  test(`cold start restores persisted fallback backend before ${failBuild ? "a failed" : "a successful"} app build`, async () => {
    const directory = await mkdtemp(join(tmpdir(), "lando-global-start-"));
    const root = AbsolutePath.make(join(directory, "app"));
    const globalRoot = AbsolutePath.make(join(directory, "global"));
    const distLandofile = AbsolutePath.make(join(globalRoot, ".lando.dist.yml"));
    const userLandofile = AbsolutePath.make(join(globalRoot, ".lando.yml"));
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
      slug: "global",
      root: globalRoot,
      identity: { appRoot: globalRoot, ownerKey: appIdentityKey("owner", globalRoot) },
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
    let appliedGlobal: AppPlan | undefined;
    const steps: string[] = [];
    const provider = {
      ...TestRuntimeProvider,
      id: "lando",
      list: (filter?: Parameters<typeof TestRuntimeProvider.list>[0]) =>
        Effect.sync(() =>
          (filter?.app === undefined || filter.app === globalPlan.id ? [...running] : []).map((service) => ({
            app: globalPlan.id,
            appRoot: globalRoot,
            providerId: globalPlan.provider,
            service: ServiceName.make(service),
            containerId: `global-${service}`,
            status: "running" as const,
            state: "running" as const,
            publications: { status: "unknown" as const },
          })),
        ),
      inspect: (target: Parameters<typeof TestRuntimeProvider.inspect>[0]) =>
        TestRuntimeProvider.inspect(target).pipe(
          Effect.map((runtime) => ({
            ...runtime,
            appRoot: target.app === globalPlan.id ? globalRoot : root,
            ...(target.app === globalPlan.id
              ? {
                  status: running.has(target.service) ? ("running" as const) : ("stopped" as const),
                  state: running.has(target.service) ? ("running" as const) : ("stopped" as const),
                  containerId: `global-${target.service}`,
                }
              : {}),
            lastStartedAt: DateTime.toDate(DateTime.makeUnsafe(-10_000)),
          })),
        ),
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
            }).pipe(
              Effect.tap(() =>
                Effect.sync(() => {
                  appliedGlobal = {
                    ...applied,
                    services: { ...appliedGlobal?.services, ...applied.services },
                  };
                }),
              ),
              Effect.as({ changed: true }),
            )
          : Effect.succeed({ changed: true }),
    };
    const globalApp: typeof GlobalAppService.Service = {
      id: "global",
      providerId: Effect.succeed(globalPlan.provider),
      root: Effect.succeed(globalRoot),
      ensureRoot: Effect.void,
      paths: Effect.succeed({ root: globalRoot, distLandofile, userLandofile }),
      ensureUserLandofile: Effect.succeed({ path: userLandofile, created: false }),
      regenerateDist: () => Effect.succeed({ path: distLandofile, status: "unchanged", serviceIds: [] }),
      ensureRunning: () => Effect.die("router setup must not be needed to start the diagnostic backend"),
    };
    try {
      await Promise.all([mkdir(root), mkdir(globalRoot)]);
      const baseConfig = Schema.decodeUnknownSync(ServiceConfig)({
        type: "compose",
        image: "node:22-alpine",
        appMount: false,
        home: false,
      });
      const configs = {
        [traefik]: { ...baseConfig, dependsOn: globalPlan.services[traefik]?.dependsOn ?? [] },
        [diagnostics]: { ...baseConfig, healthcheck: diagnosticService.healthcheck },
        unrelated: baseConfig,
      };
      const modules = await Promise.all(
        Object.entries(configs).map(async ([id, config]) => {
          const module = join(directory, `${id}.ts`);
          await writeFile(
            module,
            `import { Effect } from ${JSON.stringify(Bun.resolveSync("effect", import.meta.dir))};\nexport default Effect.succeed(${JSON.stringify(config)});\n`,
          );
          return { id, module };
        }),
      );
      const manifest = Schema.decodeUnknownSync(PluginManifest)({
        name: "@test/global-diagnostic-start",
        version: "1.0.0",
        api: 4,
        contributes: { globalServices: modules },
      });
      await writeFile(distLandofile, renderGlobalDist(configs));
      await writeFile(fallback, "service: traefik-diagnostics\n");
      const harness = makeHarness({ plannedApp: appPlan });
      const start = startApp({}, { plan: appPlan, root, app: { kind: "user", id: appPlan.id, root } }).pipe(
        Effect.provideService(GlobalAppService, globalApp),
        Effect.provideService(PluginRegistry, {
          list: Effect.succeed([manifest]),
          declaredProviderCapabilities: () => provider.capabilities,
          load: () => Effect.die("dynamic contribution modules are loaded directly"),
          loadServiceType: () => Effect.die("the diagnostic fixture supplies its planner"),
          loadServiceFeature: () => Effect.die("the diagnostic fixture supplies its planner"),
          loadAppFeature: () => Effect.die("the diagnostic fixture supplies its planner"),
        }),
        Effect.provideService(AppPlanner, {
          plan: () => Effect.succeed({ ...globalPlan, valueModel: 1 as const }),
        }),
        Effect.provideService(RuntimeProviderRegistry, {
          appliedPlansFor: (requestedRoot) =>
            Effect.sync(() =>
              appliedGlobal === undefined || requestedRoot !== globalRoot ? [] : [appliedGlobal],
            ),
          resolveAppliedPlan: (requestedRoot) =>
            Effect.sync(() => (requestedRoot === globalRoot ? appliedGlobal : undefined)),
          resolveTeardownEvidence: () => Effect.succeed({ kind: "absent" as const }),
          list: Effect.succeed([plan.provider]),
          capabilities: Effect.succeed(provider.capabilities),
          select: () => Effect.succeed(provider),
        }),
        Effect.provideService(RouterService, {
          ...TestRouterService,
          id: "traefik",
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
                        remediation:
                          "Install or start the `lando` provider and confirm it can perform `build`.",
                      }),
                    );
                  return built;
                }),
          buildApp: () => Effect.void,
        }),
        Effect.provide(harness.layer),
      );
      const result = await Effect.runPromiseExit(start);
      if (result._tag === "Failure") {
        const error = Cause.squash(result.cause);
        if (!failBuild) throw error;
        expect(error).toBeInstanceOf(ProviderUnavailableError);
      }
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
