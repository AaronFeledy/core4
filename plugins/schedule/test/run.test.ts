import { describe, expect, test } from "bun:test";
import {
  type AppliedStateVersionError,
  PlanReplanRequiredError,
  appliedStateVersionError,
} from "@lando/sdk/errors";
import {
  AbsolutePath,
  AppId,
  AppPlan,
  CLONED_SERVICE_PROVENANCE_KEY,
  LoadScopedLandofile,
  ProviderId,
  ServiceName,
  ServicePlan,
  appIdentityKey,
} from "@lando/sdk/schema";
import {
  type ExecChunk,
  type ExecTarget,
  type CommandSpec as ProviderCommandSpec,
  RuntimeProviderRegistry,
  type RuntimeProviderShape,
  StreamFrameSink,
  type StreamFrameSinkFrame,
  UserAppResolver,
} from "@lando/sdk/services";
import { TestRuntimeProvider, makeTestRuntimeProviderRegistry } from "@lando/sdk/test";
import { DateTime, Effect, Layer, Stream } from "effect";

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
  recordedRoot?: AbsolutePath,
) =>
  AppPlan.make({
    id: AppId.make("demo"),
    name: "demo",
    slug: "demo",
    root: appRoot,
    ...(recordedRoot === undefined
      ? {}
      : { identity: { appRoot: recordedRoot, ownerKey: appIdentityKey("owner", recordedRoot) } }),
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
  options: {
    readonly applied?: boolean;
    readonly planServices?: ReadonlyArray<PlannedService>;
    readonly protection?: AppliedStateVersionError;
    readonly recordedRoot?: AbsolutePath;
  } = {},
) => {
  const execs: Array<{ readonly target: ExecTarget; readonly command: ProviderCommandSpec }> = [];
  const plan = makePlan(options.planServices, options.recordedRoot);
  const order: string[] = [];
  const encoder = new TextEncoder();
  const provider: RuntimeProviderShape = {
    ...TestRuntimeProvider,
    execStream: (target, command) =>
      Stream.suspend(() => {
        execs.push({ target, command });
        const failed = command.command.includes("exit 3");
        const output: ReadonlyArray<ExecChunk> = [
          { kind: "stdout", chunk: encoder.encode("job-stdout\n") },
          ...(failed ? [{ kind: "stderr" as const, chunk: encoder.encode("job-stderr\n") }] : []),
        ];
        // The job exits only after its output was consumed, as a running process would.
        const exit = Stream.fromEffect(
          Effect.sync((): ExecChunk => {
            order.push("exit");
            return { exitCode: failed ? 3 : 0 };
          }),
        );
        return Stream.concat(Stream.fromIterable(output), exit);
      }),
  };
  const registry = makeTestRuntimeProviderRegistry({
    capabilities: Effect.die("unused"),
    appliedPlansFor: () => Effect.die("unused"),
    select: () => Effect.succeed(provider),
    resolveAppliedPlan: (_root, _app, lookup) =>
      lookup === "exact"
        ? Effect.succeed(options.applied === false ? undefined : plan)
        : Effect.die("schedule run must ask for the exact app"),
    resolveTeardownEvidence: () => Effect.die("unused"),
    readAppliedPlanStrict: () =>
      options.protection === undefined ? Effect.succeed(plan) : Effect.fail(options.protection),
  });
  const layer = Layer.mergeAll(
    Layer.succeed(
      UserAppResolver,
      UserAppResolver.of({
        current: Effect.succeed(landofile),
        load: () => Effect.succeed(landofile),
      }),
    ),
    Layer.succeed(RuntimeProviderRegistry, registry),
  );
  return {
    execs,
    order,
    run: (name: string, service?: string) =>
      Effect.runPromise(
        runScheduleJob({ name, ...(service === undefined ? {} : { service }) }).pipe(Effect.provide(layer)),
      ),
    runLive: (name: string) => {
      const frames: StreamFrameSinkFrame[] = [];
      const sink = StreamFrameSink.of({
        emit: (frame) =>
          Effect.sync(() => {
            frames.push(frame);
            order.push(`frame:${frame._tag}`);
          }),
      });
      return Effect.runPromise(
        runScheduleJob({ name }).pipe(Effect.provide(layer), Effect.provideService(StreamFrameSink, sink)),
      ).then((result) => ({ result, frames }));
    },
  };
};

describe("schedule:run", () => {
  test("refuses a newer receipt before executing a scheduled job", async () => {
    const protection = appliedStateVersionError({
      providerId: "test",
      operation: "applied-state.read",
      path: "/state/demo.json",
      storedVersion: 12,
      supportedVersion: 11,
      scope: "app",
      appId: "demo",
    });
    const runtime = makeRuntime({ protection });
    await expect(runtime.run("fail")).rejects.toMatchObject({ _tag: "AppliedStateVersionError" });
    expect(runtime.execs).toEqual([]);
  });
  test("runs a job when the applied record names the canonical form of the app root", async () => {
    // Given: the Landofile reports the root as written while the record holds its canonical form,
    // as on Windows, where the drive letter and separators can differ.
    const runtime = makeRuntime({ recordedRoot: AbsolutePath.make("/canonical/schedule-run") });

    // When / Then: the exact lookup and the strict reread agree, so the job runs.
    const result = await runtime.run("ok");
    expect(result.exitCode).toBe(0);
    expect(runtime.execs).toHaveLength(1);
  });

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

  test("streams the job's output to a live sink as it runs and leaves it out of the result", async () => {
    // Given: a caller that streams the command's output.
    const runtime = makeRuntime();

    // When: the job runs.
    const { result, frames } = await runtime.runLive("fail");

    // Then: each chunk reached the sink before the job exited, and the result carries only the status.
    expect(runtime.order).toEqual(["frame:stdout", "frame:stderr", "exit"]);
    const text = (chunk: string | Uint8Array) =>
      typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
    expect(frames.map((frame) => [frame._tag, text(frame.chunk)])).toEqual([
      ["stdout", "job-stdout\n"],
      ["stderr", "job-stderr\n"],
    ]);
    expect(result).toEqual({ service: "web", name: "fail", exitCode: 3 });
    expect(spec.streamingMode, "the spec must declare live output so the CLI provides the sink").toBe("live");
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
