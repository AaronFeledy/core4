import { describe, expect, test } from "bun:test";
import { PlanReplanRequiredError } from "@lando/sdk/errors";
import {
  AbsolutePath,
  AppId,
  AppPlan,
  CLONED_SERVICE_PROVENANCE_KEY,
  LoadScopedLandofile,
  ProviderId,
  ServiceName,
  ServicePlan,
} from "@lando/sdk/schema";
import {
  type ExecTarget,
  LandofileService,
  type CommandSpec as ProviderCommandSpec,
  RuntimeProviderRegistry,
  type RuntimeProviderShape,
} from "@lando/sdk/services";
import { TestRuntimeProvider } from "@lando/sdk/test";
import { DateTime, Effect, Layer } from "effect";

import { spec } from "../src/commands/run.ts";
import { ScheduleJobAmbiguousError, ScheduleJobNotFoundError } from "../src/errors.ts";
import { runScheduleJob } from "../src/run-job.ts";

const appRoot = AbsolutePath.make("/tmp/schedule-run");

const landofile = LoadScopedLandofile.make({
  stage: "load-scoped",
  pendingSites: [],
  context: { appRoot, env: {} },
  document: {
    name: "demo",
    services: {
      [ServiceName.make("web")]: {
        type: "compose",
        schedule: [
          { name: "ok", every: "@yearly", run: "echo ok" },
          { name: "argv", every: "@yearly", run: ["echo", "ok"] },
          { name: "fail", every: "@yearly", run: "exit 3", user: "1002" },
          { name: "dup", every: "@yearly", run: "true" },
        ],
      },
      [ServiceName.make("db")]: {
        type: "compose",
        schedule: [{ name: "dup", every: "@yearly", run: "true" }],
      },
    },
  },
});

const metadata = {
  resolvedAt: DateTime.makeUnsafe("2026-11-03T12:00:00Z"),
  source: "run.test",
  runtime: 4 as const,
};

const servicePlan = (name: string, clonedFrom?: string) =>
  ServicePlan.make({
    name: ServiceName.make(name),
    type: "compose",
    provider: ProviderId.make("lando"),
    primary: name === "web",
    environment: {},
    mounts: [],
    endpoints: [],
    routes: [],
    dependsOn: [],
    hostAliases: [],
    metadata,
    extensions: {},
    ...(clonedFrom === undefined
      ? {}
      : { provenance: { [CLONED_SERVICE_PROVENANCE_KEY]: { from: clonedFrom } } }),
  });

interface PlannedService {
  readonly name: string;
  readonly clonedFrom?: string;
}

const makePlan = (
  services: ReadonlyArray<PlannedService> = [
    { name: "web" },
    { name: "web-schedule", clonedFrom: "web" },
    { name: "web-schedule-1002", clonedFrom: "web" },
  ],
) =>
  AppPlan.make({
    id: AppId.make("demo"),
    name: "demo",
    slug: "demo",
    root: appRoot,
    provider: ProviderId.make("lando"),
    services: Object.fromEntries(
      services.map(({ name, clonedFrom }) => [ServiceName.make(name), servicePlan(name, clonedFrom)]),
    ),
    routes: [],
    stores: [],
    fileSync: [],
    metadata,
    extensions: {},
  });

const makeRuntime = (
  options: { readonly applied?: boolean; readonly planServices?: ReadonlyArray<PlannedService> } = {},
) => {
  const execs: Array<{ readonly target: ExecTarget; readonly command: ProviderCommandSpec }> = [];
  const plan = makePlan(options.planServices);
  const provider: RuntimeProviderShape = {
    ...TestRuntimeProvider,
    exec: (target, command) => {
      execs.push({ target, command });
      const failed = command.command.includes("exit 3");
      return Effect.succeed({
        exitCode: failed ? 3 : 0,
        stdout: "job-stdout\n",
        stderr: failed ? "job-stderr\n" : "",
      });
    },
  };
  const registry = RuntimeProviderRegistry.of({
    list: Effect.succeed([]),
    capabilities: Effect.die("unused"),
    appliedPlansFor: () => Effect.die("unused"),
    select: () => Effect.succeed(provider),
    resolveAppliedPlan: () => Effect.succeed(options.applied === false ? undefined : plan),
    resolveTeardownEvidence: () => Effect.die("unused"),
  });
  const layer = Layer.mergeAll(
    Layer.succeed(LandofileService, LandofileService.of({ discover: Effect.succeed(landofile) })),
    Layer.succeed(RuntimeProviderRegistry, registry),
  );
  return {
    execs,
    run: (name: string, service?: string) =>
      Effect.runPromise(
        runScheduleJob({ name, ...(service === undefined ? {} : { service }) }).pipe(Effect.provide(layer)),
      ),
  };
};

describe("schedule:run", () => {
  test("returns the completed result and classifies a nonzero exit through completion", async () => {
    const runtime = makeRuntime();
    const result = await runtime.run("fail");
    expect(result).toEqual({
      service: "web",
      name: "fail",
      exitCode: 3,
      stdout: "job-stdout\n",
      stderr: "job-stderr\n",
    });
    expect(spec.completion?.(result)).toEqual({ ok: false, exitCode: 3 });

    const success = await runtime.run("ok");
    expect(success.exitCode).toBe(0);
    expect(spec.completion?.(success)).toEqual({ ok: true, exitCode: 0 });
  });

  test("executes in the sidecar that runs the job, without a user or cwd override", async () => {
    const runtime = makeRuntime();
    await runtime.run("ok");
    const inherit = runtime.execs[0];
    expect(String(inherit?.target.service), "an inherit job must run in the unsuffixed sidecar").toBe(
      "web-schedule",
    );
    expect(
      inherit === undefined || "user" in inherit.target,
      "the sidecar already runs as the job user",
    ).toBe(false);
    expect(inherit?.command.command, "a string job must keep the shell wrapper").toEqual([
      "sh",
      "-c",
      "echo ok",
    ]);
    expect(
      inherit === undefined || "cwd" in inherit.command,
      "the sidecar default cwd is the timer cwd",
    ).toBe(false);

    await runtime.run("argv");
    expect(runtime.execs[1]?.command.command, "a list job must run as argv").toEqual(["echo", "ok"]);

    await runtime.run("fail");
    expect(String(runtime.execs[2]?.target.service), "a user group must use its suffix name").toBe(
      "web-schedule-1002",
    );
    expect(runtime.execs[2]?.command.command).toEqual(["sh", "-c", "exit 3"]);
  });

  test("fails when the applied plan predates the job's sidecar", async () => {
    const runtime = makeRuntime({ planServices: [{ name: "web" }] });
    const error = await runtime.run("ok").catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(PlanReplanRequiredError);
    if (!(error instanceof PlanReplanRequiredError)) return;
    expect(error.message, "the message must name the job and its missing sidecar").toContain("web.ok");
    expect(error.message).toContain("web-schedule");
    expect(error).toMatchObject({ app: "demo", providerId: "lando", operation: "schedule run" });
    expect(runtime.execs, "a missing sidecar must not reach the provider").toEqual([]);
  });

  test("fails when the same-named applied service was not cloned from the job's service", async () => {
    const runtime = makeRuntime({ planServices: [{ name: "web" }, { name: "web-schedule" }] });
    const error = await runtime.run("ok").catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(PlanReplanRequiredError);
    if (!(error instanceof PlanReplanRequiredError)) return;
    expect(error.message).toContain("web.ok");
    expect(error.message).toContain("web-schedule");
    expect(error).toMatchObject({ app: "demo", providerId: "lando", operation: "schedule run" });
    expect(runtime.execs, "an unprovenanced service must not reach the provider").toEqual([]);
  });

  test("fails when the sidecar was cloned from a different service", async () => {
    const runtime = makeRuntime({
      planServices: [{ name: "web" }, { name: "web-schedule", clonedFrom: "db" }],
    });
    const error = await runtime.run("ok").catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(PlanReplanRequiredError);
    expect(error).toMatchObject({ app: "demo", providerId: "lando", operation: "schedule run" });
    expect(runtime.execs, "a foreign clone must not reach the provider").toEqual([]);
  });

  test("fails with the not-found and ambiguous errors before touching the provider", async () => {
    const runtime = makeRuntime();
    await expect(runtime.run("missing")).rejects.toBeInstanceOf(ScheduleJobNotFoundError);
    await expect(runtime.run("dup")).rejects.toBeInstanceOf(ScheduleJobAmbiguousError);
    const scoped = await runtime.run("dup", "web");
    expect(scoped.service).toBe("web");
    expect(runtime.execs).toHaveLength(1);
    expect(String(runtime.execs[0]?.target.service)).toBe("web-schedule");
  });
});
