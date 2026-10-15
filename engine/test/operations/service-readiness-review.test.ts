import { expect, test } from "bun:test";
import type { RuntimeProviderShape } from "@lando/sdk/services";
import { TestRuntimeProvider } from "@lando/sdk/test";
import { Clock, DateTime, Effect, Stream } from "effect";
import { waitForServiceReadiness } from "../../src/operations/service-readiness.ts";
import { runExitUnderClock, successOf } from "../subsystems/healthcheck/support.ts";
import { plan, web } from "./start-progress-topology-support.ts";

test("a future engine StartedAt never extends settling past two seconds", async () => {
  const provider = {
    ...TestRuntimeProvider,
    inspect: (target) =>
      Effect.succeed({
        app: plan.id,
        service: target.service,
        providerId: plan.provider,
        status: "running",
        lastStartedAt: DateTime.toDate(DateTime.makeUnsafe(600_000)),
      }),
  } satisfies RuntimeProviderShape;
  const timed = await runExitUnderClock(
    waitForServiceReadiness({ provider, plan, services: [web.name] }),
    "2 seconds",
  );
  expect(successOf(timed.exit)[0]?.state).toBe("running");
  expect(timed.elapsedMs).toBe(2_000);
});

test("healthcheck waits use one global liveness poll per cadence and preserve exit evidence", async () => {
  const observations: number[] = [];
  const provider = {
    ...TestRuntimeProvider,
    inspect: (target) =>
      Effect.map(Clock.currentTimeMillis, (now) => {
        observations.push(now);
        return {
          app: plan.id,
          service: target.service,
          providerId: plan.provider,
          status: now >= 1_000 ? "stopped" : "running",
          ...(now >= 1_000 ? { exitCode: 17 } : {}),
        };
      }),
    exec: () => Effect.never,
    logs: () => Stream.make({ service: web.name, stream: "stderr", line: "startup failed" }),
  } satisfies RuntimeProviderShape;
  const checkedPlan = {
    ...plan,
    services: {
      [web.name]: {
        ...web,
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
  const timed = await runExitUnderClock(
    waitForServiceReadiness({ provider, plan: checkedPlan, services: [web.name] }),
    "1 second",
  );
  expect(observations.filter((time) => time === 250)).toHaveLength(1);
  expect(observations.filter((time) => time === 500)).toHaveLength(1);
  expect(observations.filter((time) => time === 750)).toHaveLength(1);
  if (timed.exit._tag !== "Failure") throw new TypeError("Expected readiness failure");
  expect(timed.exit.cause.reasons).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        error: expect.objectContaining({
          _tag: "ServiceNotReadyError",
          reason: "not-running",
          exitCode: 17,
          logTail: { service: "web", lines: ["startup failed"], truncated: false, exitCode: 17 },
        }),
      }),
    ]),
  );
});
