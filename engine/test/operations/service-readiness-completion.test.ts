import { expect, test } from "bun:test";
import { ServiceName } from "@lando/sdk/schema";
import { TestRuntimeProvider } from "@lando/sdk/test";
import { Effect } from "effect";
import { waitForServiceReadiness } from "../../src/operations/service-readiness.ts";
import { failureOf, runExitUnderClock, successOf } from "../subsystems/healthcheck/support.ts";
import { plan, web } from "./start-progress-topology-support.ts";

test.each(["always", "unless-stopped", "on-failure"])(
  "completion intent stays strict with %s restart policy",
  async (restart) => {
    const dependent = ServiceName.make("dependent");
    const plannedApp = {
      ...plan,
      services: {
        [web.name]: { ...web, extensions: { compose: { restart } } },
        [dependent]: {
          ...web,
          name: dependent,
          dependsOn: [
            {
              service: web.name,
              condition: "service_completed_successfully" as const,
              required: true,
            },
          ],
        },
      },
    };
    const provider = {
      ...TestRuntimeProvider,
      inspect: () =>
        Effect.succeed({
          app: plan.id,
          service: web.name,
          providerId: plan.provider,
          status: "stopped",
          exitCode: 7,
        }),
    };
    const timed = await runExitUnderClock(
      waitForServiceReadiness({ provider, plan: plannedApp, services: [web.name] }),
      "0 seconds",
    );
    expect(failureOf(timed.exit)).toMatchObject({
      _tag: "ServiceNotReadyError",
      reason: "not-running",
      exitCode: 7,
    });
    const successful = {
      ...provider,
      inspect: () =>
        Effect.succeed({
          app: plan.id,
          service: web.name,
          providerId: plan.provider,
          status: "stopped",
          exitCode: 0,
        }),
    };
    const completed = await runExitUnderClock(
      waitForServiceReadiness({ provider: successful, plan: plannedApp, services: [web.name] }),
      "0 seconds",
    );
    expect(successOf(completed.exit)[0]?.state).toBe("completed");
  },
);
