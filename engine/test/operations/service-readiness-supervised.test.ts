import { expect, test } from "bun:test";
import { type AppPlan, ServiceName } from "@lando/sdk/schema";
import { TestRuntimeProvider } from "@lando/sdk/test";
import { Clock, DateTime, Deferred, Effect, Stream } from "effect";
import { CommandWarnings, makeCommandWarnings } from "../../src/landofile/command-warnings.ts";
import { waitForServiceReadiness } from "../../src/operations/service-readiness.ts";
import { startApp } from "../../src/operations/start.ts";
import { failureOf, runExitUnderClock, successOf } from "../subsystems/healthcheck/support.ts";
import { byTag, makeHarness, plan, web } from "./start-progress-topology-support.ts";

const supervised = (restart: string): AppPlan => ({
  ...plan,
  services: { [web.name]: { ...web, extensions: { compose: { restart } } } },
});
const targetFor = (plan: AppPlan) => ({
  plan,
  root: plan.root,
  app: { kind: "user", id: plan.id, root: plan.root } as const,
});
const logs = () =>
  Stream.make({
    service: web.name,
    stream: "stderr" as const,
    line: "PASSWORD=hunter2 worker is not installed",
  });

test.each(["always", "unless-stopped", "on-failure"])(
  "%s supervised exits succeed with a redacted warning",
  async (restart) => {
    const plannedApp = supervised(restart);
    const harness = makeHarness({
      plannedApp,
      logs,
      inspect: (target) =>
        Effect.succeed({
          app: plan.id,
          service: target.service,
          providerId: plan.provider,
          status: "stopped",
          exitCode: 17,
        }),
    });
    const warnings = makeCommandWarnings(false);
    const timed = await runExitUnderClock(
      startApp({}, targetFor(plannedApp)).pipe(
        Effect.provide(harness.layer),
        Effect.provideService(CommandWarnings, warnings),
      ),
      "0 seconds",
    );
    expect(successOf(timed.exit).servicesStarted[0]?.state).toBe("restarting");
    expect(byTag(harness.events, "post-start")).toHaveLength(1);
    const emitted = byTag(harness.events, "message.warn");
    expect(emitted).toHaveLength(1);
    expect(emitted[0]?.body).toContain("web");
    expect(emitted[0]?.body).toContain("not-running");
    expect(emitted[0]?.body).toContain("exit code 17");
    expect(emitted[0]?.body).toContain("lando logs -s web");
    expect(emitted[0]?.body).not.toContain("hunter2");
    expect(await Effect.runPromise(warnings.list)).toMatchObject([
      { code: "LANDO_SERVICE_RESTARTING", context: { exitCode: "17" } },
    ]);
  },
);

test.each([undefined, "no"])(
  "unsupervised exit (%s) still fails with ServiceNotReadyError",
  async (restart) => {
    const plannedApp = restart === undefined ? plan : supervised(restart);
    const provider = {
      ...TestRuntimeProvider,
      logs,
      inspect: (target: Parameters<typeof TestRuntimeProvider.inspect>[0]) =>
        Effect.succeed({
          app: plan.id,
          service: target.service,
          providerId: plan.provider,
          status: "stopped",
          exitCode: 17,
        }),
    };
    const timed = await runExitUnderClock(
      waitForServiceReadiness({ provider, plan: plannedApp, services: [web.name] }),
      "0 seconds",
    );
    expect(failureOf(timed.exit)).toMatchObject({
      _tag: "ServiceNotReadyError",
      reason: "not-running",
      exitCode: 17,
    });
  },
);

test("a supervised crash loop stops its healthcheck wait on the first exit", async () => {
  const plannedApp = supervised("unless-stopped");
  const checked = {
    ...plannedApp,
    services: {
      [web.name]: {
        ...plannedApp.services[web.name],
        ...web,
        extensions: { compose: { restart: "unless-stopped" } },
        healthcheck: {
          kind: "command" as const,
          command: ["check"],
          startPeriodSeconds: 90,
          intervalSeconds: 10,
          timeoutSeconds: 5,
          retries: 5,
        },
      },
    },
  };
  const harness = makeHarness({
    plannedApp: checked,
    logs,
    inspect: (target) =>
      Effect.map(Clock.currentTimeMillis, (now) => ({
        app: plan.id,
        service: target.service,
        providerId: plan.provider,
        status: now >= 250 ? "stopped" : "running",
        containerId: "worker",
        lastStartedAt: DateTime.toDate(DateTime.makeUnsafe(0)),
        ...(now >= 250 ? { exitCode: 7 } : {}),
      })),
    exec: () => Effect.never,
  });
  const timed = await runExitUnderClock(
    startApp({}, targetFor(checked)).pipe(Effect.provide(harness.layer)),
    "250 millis",
  );
  expect(successOf(timed.exit).servicesStarted[0]?.state).toBe("restarting");
  expect(timed.elapsedMs).toBe(250);
  expect(byTag(harness.events, "message.warn")).toHaveLength(1);
});

test.each(["failed", "timeout"] as const)(
  "supervised exhausted healthcheck (%s) is a structured warning",
  async (mode) => {
    const checked = {
      ...plan,
      services: {
        [web.name]: {
          ...web,
          extensions: { compose: { restart: "always" } },
          healthcheck: {
            kind: "command" as const,
            command: ["check"],
            intervalSeconds: 1,
            timeoutSeconds: 1,
            retries: 1,
          },
        },
      },
    };
    const probing = Deferred.makeUnsafe<void>();
    const warnings = makeCommandWarnings(true);
    const harness = makeHarness({
      plannedApp: checked,
      logs,
      exec: () =>
        Deferred.succeed(probing, undefined).pipe(
          Effect.andThen(
            mode === "timeout" ? Effect.never : Effect.succeed({ exitCode: 1, stdout: "", stderr: "" }),
          ),
        ),
    });
    const timed = await runExitUnderClock(
      startApp({}, targetFor(checked)).pipe(
        Effect.provide(harness.layer),
        Effect.provideService(CommandWarnings, warnings),
      ),
      "1 second",
      Deferred.await(probing),
    );
    expect(successOf(timed.exit).servicesStarted[0]?.state).toBe("restarting");
    expect(await Effect.runPromise(warnings.list)).toMatchObject([
      { code: "LANDO_SERVICE_RESTARTING", context: { reason: `healthcheck-${mode}` } },
    ]);
    expect(byTag(harness.events, "message.warn")).toEqual([]);
  },
);

test("a supervised restart while a sibling waits is downgraded once", async () => {
  const slow = ServiceName.make("slow");
  const plannedApp = {
    ...supervised("always"),
    services: { ...supervised("always").services, [slow]: { ...web, name: slow } },
  };
  const harness = makeHarness();
  const provider = {
    ...TestRuntimeProvider,
    logs,
    inspect: (target: Parameters<typeof TestRuntimeProvider.inspect>[0]) =>
      Effect.map(Clock.currentTimeMillis, (now) => ({
        app: plan.id,
        service: target.service,
        providerId: plan.provider,
        status: "running",
        containerId: "container",
        lastStartedAt: DateTime.toDate(
          DateTime.makeUnsafe(target.service === web.name && now >= 250 ? 250 : 0),
        ),
      })),
  };
  const timed = await runExitUnderClock(
    waitForServiceReadiness({ provider, plan: plannedApp, services: [web.name, slow] }).pipe(
      Effect.provide(harness.layer),
    ),
    "2 seconds",
  );
  expect(successOf(timed.exit).map((row) => row.state)).toEqual(["restarting", "running"]);
  expect(byTag(harness.events, "message.warn")).toHaveLength(1);
});
