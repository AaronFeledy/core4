import { expect, test } from "bun:test";
import { ServiceName } from "@lando/sdk/schema";
import { HealthcheckRunner, type RuntimeProviderShape } from "@lando/sdk/services";
import { TestRuntimeProvider } from "@lando/sdk/test";
import { DateTime, Effect, Fiber, Stream } from "effect";
import { TestClock } from "effect/testing";
import { waitForServiceReadiness } from "../../src/operations/service-readiness.ts";
import { startReadinessTreeId } from "../../src/operations/start-progress.ts";
import { byTag, makeHarness, plan, web } from "./start-progress-topology-support.ts";

const check = {
  kind: "command" as const,
  command: ["check"],
  intervalSeconds: 1,
  timeoutSeconds: 5,
  retries: 2,
};
const running: RuntimeProviderShape["inspect"] = (target) =>
  Effect.succeed({
    app: plan.id,
    service: target.service,
    providerId: plan.provider,
    status: "running",
    state: "running",
    lastStartedAt: DateTime.toDate(DateTime.makeUnsafe(-10_000)),
  });

test.each([false, true])(
  "instant readiness does not emit a task tree (healthcheck=%s)",
  async (healthcheck) => {
    const harness = makeHarness();
    const planned = {
      ...plan,
      services: { [web.name]: { ...web, ...(healthcheck ? { healthcheck: check } : {}) } },
    };
    await Effect.runPromise(
      waitForServiceReadiness({
        provider: { ...TestRuntimeProvider, inspect: running },
        plan: planned,
        services: [web.name],
      }).pipe(Effect.provide(harness.layer), Effect.provide(TestClock.layer())),
    );
    expect(byTag(harness.events, "task.tree.start")).toEqual([]);
    expect(byTag(harness.events, "task.start")).toEqual([]);
  },
);

test("delayed readiness shows waiting services and completes their rows independently", async () => {
  const slow = ServiceName.make("slow");
  const planned = {
    ...plan,
    services: {
      [web.name]: { ...web, healthcheck: check },
      [slow]: { ...web, name: slow, healthcheck: check },
    },
  };
  const harness = makeHarness();
  const parentId = startReadinessTreeId(String(plan.id));
  const runner = HealthcheckRunner.of({
    id: "timed",
    run: (_check, _app, service) =>
      Effect.sleep(service === slow ? "2 seconds" : "1 second").pipe(
        Effect.as({ healthy: true, service, attempts: 1 }),
      ),
  });
  await Effect.runPromise(
    Effect.gen(function* () {
      const fiber = yield* Effect.forkChild(
        waitForServiceReadiness({
          provider: { ...TestRuntimeProvider, inspect: running },
          plan: planned,
          services: [web.name, slow],
          runner,
        }),
      );
      yield* TestClock.adjust("100 millis");
      expect(byTag(harness.events, "task.tree.start")).toMatchObject([
        { parentId, children: [`${parentId}:web`, `${parentId}:slow`] },
      ]);
      yield* TestClock.adjust("900 millis");
      expect(byTag(harness.events, "task.complete").map((event) => event.taskId)).toEqual([
        `${parentId}:web`,
      ]);
      expect(byTag(harness.events, "task.tree.complete")).toEqual([]);
      yield* TestClock.adjust("1 second");
      yield* Fiber.join(fiber);
    }).pipe(Effect.provide(harness.layer), Effect.provide(TestClock.layer())),
  );
  expect(byTag(harness.events, "task.tree.complete")).toMatchObject([{ parentId, succeeded: 2, failed: 0 }]);
});

test("an exit during a healthcheck reports the readiness reason and stopped exit evidence in progress", async () => {
  const harness = makeHarness();
  let exited = false;
  const provider = {
    ...TestRuntimeProvider,
    inspect: (target) =>
      exited
        ? Effect.succeed({
            app: plan.id,
            service: target.service,
            providerId: plan.provider,
            status: "stopped",
            exitCode: 17,
          })
        : running(target),
    exec: () => Effect.never,
    logs: () => Stream.make({ service: web.name, stream: "stderr", line: "failed startup" }),
  } satisfies RuntimeProviderShape;
  const planned = { ...plan, services: { [web.name]: { ...web, healthcheck: check } } };
  await Effect.runPromise(
    Effect.gen(function* () {
      const fiber = yield* Effect.forkChild(
        Effect.exit(waitForServiceReadiness({ provider, plan: planned, services: [web.name] })),
      );
      yield* TestClock.adjust("100 millis");
      exited = true;
      yield* TestClock.adjust("150 millis");
      yield* Fiber.join(fiber);
    }).pipe(Effect.provide(harness.layer), Effect.provide(TestClock.layer())),
  );
  const parentId = startReadinessTreeId(String(plan.id));
  expect(byTag(harness.events, "task.fail")).toMatchObject([
    {
      taskId: `${parentId}:web`,
      summary: "web: not-running",
      exitCode: 17,
      remediation: expect.stringContaining("lando logs -s web"),
    },
  ]);
  expect(byTag(harness.events, "task.tree.complete")).toMatchObject([{ succeeded: 0, failed: 1 }]);
});
