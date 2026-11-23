import { expect, test } from "bun:test";
import { ArtifactBuildError } from "@lando/sdk/errors";
import { type AppPlan, ServiceName, type ServicePlan } from "@lando/sdk/schema";
import { BuildOrchestrator } from "@lando/sdk/services";
import { Effect, Exit } from "effect";
import { CommandWarnings, makeCommandWarnings } from "../../src/landofile/command-warnings.ts";
import { rebuildApp } from "../../src/operations/rebuild.ts";
import { restartApp } from "../../src/operations/restart.ts";
import { byTag, makeHarness, plan, web } from "./start-progress-topology-support.ts";

const lowPortWeb: ServicePlan = {
  ...web,
  user: "www-data",
  endpoints: [{ kind: "internal", protocol: "http", port: 80 }],
};
const worker: ServicePlan = { ...web, name: ServiceName.make("worker"), primary: false, endpoints: [] };
const lowPortPlan: AppPlan = { ...plan, services: { [web.name]: lowPortWeb, [worker.name]: worker } };

const buildFailure = new ArtifactBuildError({
  providerId: "lando",
  operation: "buildArtifact",
  message: "step failed",
  remediation: "Fix the failing build step.",
});

const relaunch = (input: {
  readonly operation: "restart" | "rebuild";
  readonly services?: ReadonlyArray<ServiceName>;
  readonly failBuild?: boolean;
}) => {
  const trace: string[] = [];
  const warnings = makeCommandWarnings(false);
  const harness = makeHarness({
    plannedApp: lowPortPlan,
    onPublish: (event) =>
      Effect.sync(() => {
        if (["message.warn", "pre-restart", "pre-rebuild"].includes(event._tag)) trace.push(event._tag);
      }),
    onApply: () => trace.push("apply"),
  });
  const operation = (input.operation === "restart" ? restartApp : rebuildApp)(
    input.services === undefined ? {} : { services: input.services },
    {
      plan: lowPortPlan,
      root: lowPortPlan.root,
      app: { kind: "user", id: lowPortPlan.id, root: lowPortPlan.root },
    },
  ).pipe(
    Effect.provideService(CommandWarnings, warnings),
    Effect.provideService(BuildOrchestrator, {
      build: (appPlan) =>
        Effect.suspend(() => {
          trace.push("build");
          return input.failBuild === true ? Effect.fail(buildFailure) : Effect.succeed(appPlan);
        }),
      buildApp: () => Effect.void,
    }),
    Effect.provide(harness.layer),
  );
  return { trace, warnings, harness, operation };
};

test("a selected restart reports the low-port warning once, before its hooks and builds", async () => {
  // Given a started app whose selected service listens on port 80 as a named user.
  const run = relaunch({ operation: "restart", services: [web.name] });
  // When only that service restarts.
  await Effect.runPromise(run.operation);
  // Then the warning is recorded once and printed before the pre-restart hook and the build.
  const recorded = await Effect.runPromise(run.warnings.list);
  expect(recorded.map(({ code, context }) => [code, context?.service])).toEqual([
    ["LANDO_NONROOT_LOW_PORT_UNVERIFIED", "web"],
  ]);
  expect(run.trace.slice(0, 3)).toEqual(["message.warn", "pre-restart", "build"]);
  expect(byTag(run.harness.events, "message.warn")).toHaveLength(1);
});

test("a whole restart reports the warning once although its relaunch announces it again", async () => {
  // Given the same app restarted as a whole, which halts and launches it again.
  const run = relaunch({ operation: "restart" });
  // When it restarts.
  await Effect.runPromise(run.operation);
  // Then the launch's own announcement does not repeat the warning.
  expect(await Effect.runPromise(run.warnings.list)).toHaveLength(1);
  expect(byTag(run.harness.events, "message.warn")).toHaveLength(1);
  expect(run.trace[0]).toBe("message.warn");
});

test("a selected rebuild whose build fails still reports the warning first", async () => {
  // Given a selected rebuild whose artifact build fails.
  const run = relaunch({ operation: "rebuild", services: [web.name], failBuild: true });
  // When it runs.
  const exit = await Effect.runPromiseExit(run.operation);
  // Then the failure carries the recorded warning, printed before the build began.
  expect(Exit.isFailure(exit)).toBe(true);
  const recorded = await Effect.runPromise(run.warnings.list);
  expect(recorded.map(({ code }) => code)).toEqual(["LANDO_NONROOT_LOW_PORT_UNVERIFIED"]);
  expect(run.trace).toEqual(["message.warn", "pre-rebuild", "build"]);
});
