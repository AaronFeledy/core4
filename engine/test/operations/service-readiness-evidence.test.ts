import { expect, test } from "bun:test";
import { ProviderUnavailableError, ServiceNotReadyError } from "@lando/sdk/errors";
import type { RuntimeProviderShape } from "@lando/sdk/services";
import { TestRuntimeProvider } from "@lando/sdk/test";
import { Clock, DateTime, Effect, Stream } from "effect";
import { inspectServiceRunning, waitForServiceReadiness } from "../../src/operations/service-readiness.ts";
import { startApp } from "../../src/operations/start.ts";
import {
  failureOf,
  runExitUnderClock,
  secret,
  withFakeRedaction,
} from "../subsystems/healthcheck/support.ts";
import { makeHarness, plan, web } from "./start-progress-topology-support.ts";

const stopped = {
  app: plan.id,
  service: web.name,
  providerId: plan.provider,
  status: "stopped",
  exitCode: 17,
};
const target = { plan, service: web.name };

test("readiness inspection transport failures are tagged, redacted, and retain applied resources", async () => {
  let cleanup = 0;
  const providerError = new ProviderUnavailableError({
    message: `inspect saw password=${secret}`,
    providerId: "lando",
    operation: "inspect",
  });
  const harness = makeHarness({
    inspect: () => Effect.fail(providerError),
    onDestroy: () => {
      cleanup++;
    },
    onRemoveRoutes: () => {
      cleanup++;
    },
  });
  const timed = await runExitUnderClock(
    withFakeRedaction(
      startApp(
        {},
        {
          plan,
          root: plan.root,
          app: { kind: "user", id: plan.id, root: plan.root },
        },
      ).pipe(Effect.provide(harness.layer)),
    ),
    "0 seconds",
  );
  const error = failureOf(timed.exit);
  expect(error).toMatchObject({ _tag: "ServiceNotReadyError", reason: "inspect-failed" });
  expect(JSON.stringify(error)).not.toContain(secret);
  expect(cleanup).toBe(0);
});

test("provider observation failure cannot become a supervised restart", async () => {
  // Given a supervised service whose provider cannot be observed.
  const supervisedPlan = {
    ...plan,
    services: { [web.name]: { ...web, extensions: { compose: { restart: "always" } } } },
  };
  const provider = {
    ...TestRuntimeProvider,
    inspect: () =>
      Effect.fail(
        new ProviderUnavailableError({
          providerId: "lando",
          operation: "inspect",
          message: "provider unreachable",
        }),
      ),
  } satisfies RuntimeProviderShape;
  // When start waits for readiness.
  const timed = await runExitUnderClock(
    waitForServiceReadiness({ provider, plan: supervisedPlan, services: [web.name] }),
    "0 seconds",
  );
  // Then provider diagnosis is fatal, not a successful restarting row.
  expect(failureOf(timed.exit)).toMatchObject({
    _tag: "ServiceNotReadyError",
    reason: "inspect-failed",
    remediation: expect.stringContaining("lando doctor"),
  });
});

test("readiness log tails use the shared redaction and line/character bounds", async () => {
  const provider = {
    ...TestRuntimeProvider,
    inspect: () => Effect.succeed(stopped),
    logs: () =>
      Stream.fromIterable(
        Array.from({ length: 80 }, (_, index) => ({
          service: web.name,
          stream: "stderr" as const,
          line: `${index} ${secret} ${"x".repeat(100)}`,
        })),
      ),
  } satisfies RuntimeProviderShape;
  const timed = await runExitUnderClock(
    withFakeRedaction(inspectServiceRunning({ ...target, provider })),
    "0 seconds",
  );
  const error = failureOf(timed.exit);
  expect(error).toMatchObject({ _tag: "ServiceNotReadyError", logTail: { truncated: true, exitCode: 17 } });
  const encoded = JSON.stringify(error);
  expect(encoded).not.toContain(secret);
  expect(encoded).toContain("[REDACTED]");
  if (!(error instanceof ServiceNotReadyError) || error.logTail === undefined)
    throw new TypeError("Expected error evidence");
  const tail = error.logTail;
  expect(tail.lines.length).toBeLessThanOrEqual(50);
  expect(tail.lines.join("\n").length).toBeLessThanOrEqual(4_000);
});

test.each(["failed", "timeout"] as const)(
  "log capture %s cannot replace the primary readiness error",
  async (mode) => {
    const provider = {
      ...TestRuntimeProvider,
      inspect: () => Effect.succeed(stopped),
      logs: () =>
        mode === "timeout"
          ? Stream.fromEffect(Effect.never)
          : Stream.fail(
              new ProviderUnavailableError({
                providerId: "lando",
                operation: "logs",
                message: "capture failed",
              }),
            ),
    } satisfies RuntimeProviderShape;
    const timed = await runExitUnderClock(inspectServiceRunning({ ...target, provider }), "4 seconds");
    expect(failureOf(timed.exit)).toMatchObject({
      _tag: "ServiceNotReadyError",
      reason: "not-running",
      exitCode: 17,
    });
    expect(failureOf(timed.exit)).not.toHaveProperty("logTail");
  },
);

test("a changed StartedAt fails readiness even when the container id is unchanged", async () => {
  const provider = {
    ...TestRuntimeProvider,
    inspect: () =>
      Effect.map(Clock.currentTimeMillis, (now) => ({
        ...stopped,
        status: "running",
        state: "running",
        containerId: "same-container",
        lastStartedAt: DateTime.toDate(DateTime.makeUnsafe(now >= 250 ? 250 : 0)),
      })),
  } satisfies RuntimeProviderShape;
  const timed = await runExitUnderClock(
    waitForServiceReadiness({ provider, plan, services: [web.name] }),
    "250 millis",
  );
  expect(failureOf(timed.exit)).toMatchObject({
    _tag: "ServiceNotReadyError",
    reason: "not-running",
    lastStatus: expect.stringContaining("restarted"),
  });
});
