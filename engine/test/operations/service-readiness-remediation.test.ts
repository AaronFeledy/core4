import { expect, test } from "bun:test";
import { ServiceNotReadyError } from "@lando/sdk/errors";
import { AppId } from "@lando/sdk/schema";
import { TestRuntimeProvider } from "@lando/sdk/test";
import { Effect } from "effect";
import { CommandWarnings, makeCommandWarnings } from "../../src/landofile/command-warnings.ts";
import { waitForServiceReadiness } from "../../src/operations/service-readiness.ts";
import { failureOf, runExitUnderClock, successOf } from "../subsystems/healthcheck/support.ts";
import { plan, web } from "./start-progress-topology-support.ts";

test.each([
  { kind: "user", logs: "lando logs -s web", retry: "lando start" },
  { kind: "global", logs: "lando global:logs -s web", retry: "lando global:start" },
  { kind: "scratch", logs: "lando scratch logs scratch-demo", retry: undefined },
])("$kind readiness remediation addresses the owning app", async ({ kind, logs, retry }) => {
  const plannedApp = {
    ...plan,
    id: AppId.make(kind === "global" ? "global" : kind === "scratch" ? "scratch-demo" : String(plan.id)),
    extensions: kind === "scratch" ? { "@lando/core/scratch": { id: "scratch-demo" } } : {},
  };
  const provider = {
    ...TestRuntimeProvider,
    inspect: () =>
      Effect.succeed({
        app: plannedApp.id,
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
  const error = failureOf(timed.exit);
  if (!(error instanceof ServiceNotReadyError)) throw new TypeError("Expected readiness error");
  const remediation = error.remediation;
  expect(remediation).toContain(logs);
  if (retry === undefined) expect(remediation).not.toContain("retry");
  else expect(remediation).toContain(retry);
});

test("global supervised warnings use global logs", async () => {
  const plannedApp = {
    ...plan,
    id: AppId.make("global"),
    services: {
      [web.name]: { ...web, extensions: { compose: { restart: "always" } } },
    },
  };
  const warnings = makeCommandWarnings(true);
  const provider = {
    ...TestRuntimeProvider,
    inspect: () =>
      Effect.succeed({
        app: plannedApp.id,
        service: web.name,
        providerId: plan.provider,
        status: "stopped",
        exitCode: 7,
      }),
  };
  const timed = await runExitUnderClock(
    waitForServiceReadiness({
      provider,
      plan: plannedApp,
      services: [web.name],
    }).pipe(Effect.provideService(CommandWarnings, warnings)),
    "0 seconds",
  );
  expect(successOf(timed.exit)[0]?.state).toBe("restarting");
  expect(await Effect.runPromise(warnings.list)).toMatchObject([{ remediation: "lando global:logs -s web" }]);
});
