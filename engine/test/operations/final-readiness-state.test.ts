import { expect, test } from "bun:test";
import { rmSync } from "node:fs";
import type { AppPlan, ServiceState } from "@lando/sdk/schema";
import { UrlScanner } from "@lando/sdk/services";
import { makeTestUrlScanner } from "@lando/sdk/test";
import { DateTime, Effect } from "effect";
import { startApp } from "../../src/operations/start.ts";
import { makeHarness, plan, web } from "./start-progress-topology-support.ts";

for (const phase of ["readiness", "final-inspect"] as const) {
  test.each(["paused", "restarting"] as const)(
    `%s observed during ${phase} cannot produce active connections or scans`,
    async (state) => {
      // Given a running service whose lifecycle changes after a successful healthcheck.
      let checked = false;
      let observations = 0;
      const plannedApp: AppPlan = {
        ...plan,
        services: {
          [web.name]: {
            ...web,
            healthcheck: {
              kind: "command",
              command: ["check"],
              retries: 1,
              timeoutSeconds: 1,
              intervalSeconds: 1,
            },
          },
        },
      };
      const scanner = makeTestUrlScanner();
      const harness = makeHarness({
        plannedApp,
        inspect: ({ service }) =>
          Effect.sync(() => {
            if (checked) observations++;
            const observedState: ServiceState =
              observations >= (phase === "readiness" ? 1 : 2) ? state : "running";
            return {
              app: plan.id,
              service,
              providerId: plan.provider,
              status: "running",
              state: observedState,
              lastStartedAt: DateTime.toDate(DateTime.makeUnsafe(-10_000)),
              publications: {
                status: "present" as const,
                bindings: [
                  { port: 3000, transport: "tcp" as const, bindAddress: "127.0.0.1", hostPort: 3000 },
                ],
              },
            };
          }),
        exec: () =>
          Effect.sync(() => {
            checked = true;
            return { exitCode: 0, stdout: "", stderr: "" };
          }),
      });
      try {
        // When the public start operation projects its final observation.
        const result = await Effect.runPromise(
          startApp(
            {},
            {
              plan: plannedApp,
              root: plan.root,
              app: { kind: "user", id: plan.id, root: plan.root },
            },
          ).pipe(Effect.provideService(UrlScanner, scanner), Effect.provide(harness.layer)),
        );
        // Then the state is authoritative and no connection is eligible for scanning.
        expect(result.servicesStarted[0]?.state).toBe(state);
        expect(result.servicesStarted[0]?.connections.map((connection) => connection.state)).toEqual([
          state === "paused" ? "inactive" : "unknown",
          state === "paused" ? "inactive" : "unknown",
        ]);
        expect(scanner.calls.filter((call) => call.op === "scan")).toEqual([]);
      } finally {
        rmSync(harness.userDataRoot, { recursive: true, force: true });
      }
    },
  );
}
