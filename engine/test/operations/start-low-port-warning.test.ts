import { expect, test } from "bun:test";
import { ProviderId } from "@lando/sdk/schema";
import { BuildOrchestrator, RuntimeProviderRegistry, ToolingEngine } from "@lando/sdk/services";
import { Effect } from "effect";
import { CommandWarnings, makeCommandWarnings } from "../../src/landofile/command-warnings.ts";
import { startApp } from "../../src/operations/start.ts";
import { withAuthoredProjectEvents } from "./event-plan.ts";
import { byTag, makeHarness, plan, web } from "./start-progress-topology-support.ts";

for (const providerId of ["lando", "docker", "custom-runtime"]) {
  for (const rootless of [true, false]) {
    for (const machineOutput of [true, false]) {
      test(`warns before hooks/builds without rejecting ${providerId}, rootless=${rootless}, machine=${machineOutput}`, async () => {
        // Given: no capability here proves effective container bind permission.
        const provider = ProviderId.make(providerId);
        const plannedApp = withAuthoredProjectEvents(
          {
            ...plan,
            provider,
            services: {
              [web.name]: {
                ...web,
                provider,
                user: "www-data",
                endpoints: [
                  { _tag: "internal" as const, protocol: "http" as const, port: 80 },
                  { _tag: "published" as const, protocol: "http" as const, port: 80, publication: {} },
                ],
              },
            },
          },
          { "pre-start": ["hook"] },
        );
        const trace: string[] = [];
        const warnings = makeCommandWarnings(machineOutput);
        const harness = makeHarness({
          plannedApp,
          onPublish: (event) =>
            Effect.sync(() => {
              if (["pre-app-start", "pre-start", "message.warn"].includes(event._tag)) trace.push(event._tag);
            }),
          onApply: () => trace.push("apply"),
        });
        const selectedProvider = await Effect.runPromise(harness.runtimeProviderRegistry.select());

        // When: drive the actual start operation, with an authored hook and both build phases.
        const result = await Effect.runPromise(
          startApp(
            {},
            {
              plan: plannedApp,
              root: plannedApp.root,
              app: { kind: "user", id: plannedApp.id, root: plannedApp.root },
            },
          ).pipe(
            Effect.provideService(CommandWarnings, {
              ...warnings,
              add: (warning) =>
                Effect.sync(() => {
                  trace.push("warning");
                }).pipe(Effect.andThen(warnings.add(warning))),
            }),
            Effect.provideService(RuntimeProviderRegistry, {
              ...harness.runtimeProviderRegistry,
              select: () =>
                Effect.succeed({
                  ...selectedProvider,
                  id: providerId,
                  capabilities: { ...selectedProvider.capabilities, rootless },
                }),
            }),
            Effect.provideService(BuildOrchestrator, {
              build: (appPlan) =>
                Effect.sync(() => {
                  trace.push("build");
                  return appPlan;
                }),
              buildApp: () =>
                Effect.sync(() => {
                  trace.push("build-app");
                }),
            }),
            Effect.provideService(ToolingEngine, {
              id: "recording",
              run: (invocation) =>
                Effect.sync(() => {
                  trace.push("hook");
                  return {
                    tool: invocation.tool,
                    service: invocation.service ?? web.name,
                    exitCode: 0,
                    stdout: "",
                    stderr: "",
                  };
                }),
            }),
            Effect.provide(harness.layer),
          ),
        );

        // Then: the advisory is early and non-blocking, once per service/container port.
        expect(result.servicesStarted.map((service) => service.name)).toEqual(["web"]);
        const recorded = await Effect.runPromise(warnings.list);
        expect(recorded).toHaveLength(1);
        expect(recorded[0]).toMatchObject({
          code: "LANDO_NONROOT_LOW_PORT_UNVERIFIED",
          context: { service: "web", provider: providerId, user: "www-data", port: "80", policy: "unknown" },
        });
        expect(byTag(harness.events, "message.warn")).toHaveLength(machineOutput ? 0 : 1);
        expect(trace).toEqual([
          "warning",
          ...(machineOutput ? [] : ["message.warn"]),
          "pre-app-start",
          "pre-start",
          "hook",
          "build",
          "apply",
          "build-app",
        ]);
      });
    }
  }
}
