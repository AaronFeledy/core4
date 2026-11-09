import { expect, test } from "bun:test";
import { ServiceNotReadyError } from "@lando/sdk/errors";
import { type RuntimeProviderShape, ServiceReadiness } from "@lando/sdk/services";
import { TestRuntimeProvider } from "@lando/sdk/test";
import { Deferred, Effect } from "effect";
import * as PlannedServiceReadiness from "../../src/operations/service-readiness.ts";
import { failureOf, runExitUnderClock, successOf } from "../subsystems/healthcheck/support.ts";
import { plan, web } from "./start-progress-topology-support.ts";

test.each([0, 1])("readiness port observes the applied probe result (%s)", async (exitCode) => {
  const probing = Deferred.makeUnsafe<void>();
  const planned = {
    ...plan,
    services: {
      [web.name]: {
        ...web,
        readiness: {
          kind: "command" as const,
          command: ["check-effective-readiness"],
          intervalSeconds: 1,
          timeoutSeconds: 1,
          retries: 1,
        },
      },
    },
  };
  const provider: RuntimeProviderShape = {
    ...TestRuntimeProvider,
    inspect: () =>
      Effect.succeed({
        app: plan.id,
        service: web.name,
        providerId: plan.provider,
        status: "running",
        publications: { status: "unknown" },
        containerId: "same-container",
      }),
    exec: () => Deferred.succeed(probing, undefined).pipe(Effect.as({ exitCode, stdout: "", stderr: "" })),
  };

  const timed = await runExitUnderClock(
    Effect.flatMap(ServiceReadiness, (readiness) =>
      readiness.wait({ provider, plan: planned, services: [web.name] }),
    ).pipe(Effect.provide(PlannedServiceReadiness.layer)),
    "1 second",
    Deferred.await(probing),
  );

  if (exitCode === 0) expect(successOf(timed.exit)).toBeUndefined();
  else {
    expect(failureOf(timed.exit)).toBeInstanceOf(ServiceNotReadyError);
    expect(failureOf(timed.exit)).toMatchObject({ service: "web", reason: "healthcheck-failed" });
  }
});
