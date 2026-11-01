import { expect, test } from "bun:test";
import { makeLandoPaths } from "@lando/paths";
import { GlobalConfig, ServiceName, type ServicePlan } from "@lando/sdk/schema";
import { ConfigService, PathsService } from "@lando/sdk/services";
import { Deferred, Effect, Fiber, Layer, Schema, Stream } from "effect";
import { TestClock } from "effect/testing";
import { listenerDoctorChecks } from "../../src/cli/commands/doctor-listeners.ts";
import { buildDoctorReportSummary } from "../../src/cli/commands/doctor-report-render.ts";
import { doctor, renderDoctorResult, renderDoctorResultAsNdjson } from "../../src/cli/commands/doctor.ts";
import {
  listenerOutput,
  listenerProvider,
  listenerRegistry,
  tcpTable,
  withListenerApp,
} from "./doctor-listeners-fixture.ts";

const collect = () => listenerDoctorChecks({ budgetMs: 5000, redact: (value) => value });

test.each([
  ["00000000", "pass", "listening"],
  ["0100007F", "warn", "loopback-only"],
  [undefined, "warn", "not-listening"],
] as const)("classifies app listener bindings %s", async (address, status, listenerState) => {
  await withListenerApp(async (plan) => {
    const provider = listenerProvider(plan, { execStream: () => listenerOutput(tcpTable(address)) });
    const result = await Effect.runPromise(collect().pipe(Effect.provide(listenerRegistry(plan, provider))));
    expect(result.checks).toHaveLength(1);
    expect(result.checks[0]).toMatchObject({
      status,
      providerId: "docker",
      context: { listenerState, service: "web", port: "8080" },
    });
    const text = renderDoctorResult(result);
    expect(text).toContain(`listenerState: ${listenerState}`);
    if (status === "warn") {
      expect(result.checks[0]?.solutions[0]?.description).toContain("Your application owns this listener.");
      expect(text).toContain("solution[manual]:");
    } else {
      expect(result.checks[0]?.solutions).toEqual([]);
      expect(text).not.toContain("readiness still failed");
    }
    if (listenerState === "not-listening")
      expect(text).toContain(
        "No TCP listener was observed on planned port 8080 at this instant. If the application is still starting, rerun `lando doctor --app`.",
      );
    expect(renderDoctorResultAsNdjson(result)).toContain(`"listenerState":"${listenerState}"`);
    const summary = buildDoctorReportSummary(
      {
        version: "test",
        provider: result,
        subsystems: { checks: [] },
        globalApp: { checks: [] },
        mcp: { checks: [] },
      },
      { all: true },
    );
    expect(
      summary.sections.flatMap((section) => section.rows).find((row) => row.label === "app-listener")?.fields,
    ).toContainEqual({ label: "service", value: "web" });
  });
});

test.each(["", "unreadable table"])("skips unavailable observation %j without a warning", async (text) => {
  await withListenerApp(async (plan) => {
    const provider = listenerProvider(plan, { execStream: () => listenerOutput(text) });
    const result = await Effect.runPromise(collect().pipe(Effect.provide(listenerRegistry(plan, provider))));
    expect(result.checks).toEqual([]);
    expect(result.skipped).toMatchObject([{ section: "app-listener:web", status: "skipped" }]);
  });
});

test.each(["not-running", "no-listener"])("does not exec when %s", async (reason) => {
  await withListenerApp(async (original) => {
    const plan =
      reason === "no-listener"
        ? {
            ...original,
            services: Object.fromEntries(
              Object.entries(original.services).map(([name, service]) => [
                name,
                { ...service, endpoints: [] },
              ]),
            ),
          }
        : original;
    let executions = 0;
    const provider = listenerProvider(plan, {
      ...(reason === "not-running" ? { list: () => Effect.succeed([]) } : {}),
      execStream: () => {
        executions++;
        return listenerOutput(tcpTable("00000000"));
      },
    });
    const result = await Effect.runPromise(collect().pipe(Effect.provide(listenerRegistry(plan, provider))));
    expect(result.checks).toEqual([]);
    expect(result.skipped).toHaveLength(1);
    expect(executions).toBe(0);
  });
});

test("skips an app with no applied plan instead of inspecting desired state", async () => {
  await withListenerApp(async (plan) => {
    const result = await Effect.runPromise(
      collect().pipe(Effect.provide(listenerRegistry(undefined, listenerProvider(plan)))),
    );
    expect(result.checks).toEqual([]);
    expect(result.skipped?.[0]?.reason).toContain("No applied plan");
  });
});

test.each(["list", "exec"])("skips provider %s failures without failing doctor", async (phase) => {
  await withListenerApp(async (plan) => {
    const provider = listenerProvider(plan, {
      ...(phase === "list" ? { list: () => Effect.die("unavailable") } : {}),
      execStream: () => Stream.die("unavailable"),
    });
    const result = await Effect.runPromise(collect().pipe(Effect.provide(listenerRegistry(plan, provider))));
    expect(result.checks).toEqual([]);
    expect(result.selfChecks).toBeUndefined();
    expect(result.skipped).toHaveLength(1);
  });
});

test("selects the applied provider and runs only under --app", async () => {
  await withListenerApp(async (plan) => {
    let executions = 0;
    const provider = listenerProvider(plan, {
      execStream: (target) => {
        expect(String(target.plan?.provider)).toBe("docker");
        executions++;
        return listenerOutput(tcpTable("00000000"));
      },
    });
    const config = Schema.decodeSync(GlobalConfig)({
      defaultProviderId: plan.provider,
      telemetry: { enabled: false },
    });
    const layers = Layer.mergeAll(
      listenerRegistry(plan, provider),
      Layer.succeed(PathsService, makeLandoPaths({ platform: "linux", env: {} })),
      Layer.succeed(
        ConfigService,
        ConfigService.of({ load: Effect.succeed(config), get: (key) => Effect.succeed(config[key]) }),
      ),
    );
    const withoutApp = await Effect.runPromise(
      doctor({ env: {}, flagProviderId: "lando" }, []).pipe(Effect.provide(layers)),
    );
    expect(withoutApp.checks.filter((check) => check.name === "app-listener")).toEqual([]);
    expect(executions).toBe(0);
    const withApp = await Effect.runPromise(
      doctor({ env: {}, app: true, flagProviderId: "lando" }, []).pipe(Effect.provide(layers)),
    );
    expect(withApp.checks.find((check) => check.name === "app-listener")).toMatchObject({
      status: "pass",
      providerId: "docker",
    });
    expect(executions).toBe(1);
  });
});

test("bounds simultaneous listener reads to four", async () => {
  await withListenerApp(async (original) => {
    const web = Object.values(original.services)[0];
    if (web === undefined) throw new Error("fixture requires a service");
    const services: Record<string, ServicePlan> = Object.fromEntries(
      Array.from({ length: 9 }, (_, index) => {
        const name = ServiceName.make(`web${index}`);
        return [name, { ...web, name }];
      }),
    );
    const plan = { ...original, services };
    let active = 0;
    let peak = 0;
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const fourStarted = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const provider = listenerProvider(plan, {
          execStream: () =>
            Stream.unwrap(
              Effect.gen(function* () {
                active++;
                peak = Math.max(peak, active);
                if (active === 4) yield* Deferred.succeed(fourStarted, undefined);
                yield* Deferred.await(release);
                active--;
                return listenerOutput(tcpTable("00000000"));
              }),
            ),
        });
        const fiber = yield* Effect.forkChild(
          collect().pipe(Effect.provide(listenerRegistry(plan, provider))),
        );
        yield* Deferred.await(fourStarted);
        yield* Deferred.succeed(release, undefined);
        return yield* Fiber.join(fiber);
      }).pipe(Effect.timeout("10 seconds")),
    );
    expect(peak).toBe(4);
    expect(result.checks).toHaveLength(9);
  });
});

test("turns a section budget expiry into a skip, not a doctor failure", async () => {
  await withListenerApp(async (plan) => {
    const provider = listenerProvider(plan, { list: () => Effect.never });
    const result = await Effect.runPromise(
      listenerDoctorChecks({ budgetMs: 10, redact: (value) => value }).pipe(
        Effect.provide(listenerRegistry(plan, provider)),
      ),
    );
    expect(result.checks).toEqual([]);
    expect(result.selfChecks).toBeUndefined();
    expect(result.skipped?.[0]?.section).toBe("app-listeners");
  });
});

test("keeps multiple waves of bounded reads within the production section budget", async () => {
  await withListenerApp(async (original) => {
    const web = Object.values(original.services)[0];
    if (web === undefined) throw new Error("fixture requires a service");
    const services = Object.fromEntries(
      Array.from({ length: 9 }, (_, index) => {
        const name = ServiceName.make(`web${index}`);
        return [name, { ...web, name }];
      }),
    );
    const plan = { ...original, services };
    const config = Schema.decodeSync(GlobalConfig)({ telemetry: { enabled: false } });
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const started = yield* Deferred.make<void>();
        const provider = listenerProvider(plan, {
          execStream: () =>
            Stream.unwrap(
              Effect.gen(function* () {
                yield* Deferred.succeed(started, undefined);
                yield* Effect.sleep("1800 millis");
                return listenerOutput(tcpTable("00000000"));
              }),
            ),
        });
        const layers = Layer.mergeAll(
          listenerRegistry(plan, provider),
          Layer.succeed(PathsService, makeLandoPaths({ platform: "linux", env: {} })),
          Layer.succeed(
            ConfigService,
            ConfigService.of({ load: Effect.succeed(config), get: (key) => Effect.succeed(config[key]) }),
          ),
        );
        const fiber = yield* Effect.forkChild(
          doctor({ app: true, env: {}, flagProviderId: "lando" }, []).pipe(Effect.provide(layers)),
        );
        yield* Deferred.await(started);
        yield* TestClock.adjust("5400 millis");
        return yield* Fiber.join(fiber);
      }).pipe(Effect.provide(TestClock.layer())),
    );
    expect(result.checks.filter((check) => check.name === "app-listener")).toHaveLength(9);
    expect(result.skipped?.filter((entry) => entry.section.startsWith("app-listener")) ?? []).toEqual([]);
  });
});
