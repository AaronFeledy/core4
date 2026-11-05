import { expect, test } from "bun:test";
import { ServiceNotReadyError } from "@lando/sdk/errors";
import { AppId } from "@lando/sdk/schema";
import { TestRuntimeProvider } from "@lando/sdk/test";
import { Effect } from "effect";
import { Stream } from "effect";
import { CommandWarnings, makeCommandWarnings } from "../../src/landofile/command-warnings.ts";
import { failReadiness } from "../../src/operations/service-readiness-error.ts";
import { waitForServiceReadiness } from "../../src/operations/service-readiness.ts";
import { failureOf, runExitUnderClock, successOf } from "../subsystems/healthcheck/support.ts";
import { plan, web } from "./start-progress-topology-support.ts";

test.each(["user", "global", "scratch"])("%s readiness includes observed listener evidence", async (kind) => {
  const service = {
    ...web,
    endpoints: [{ _tag: "internal", protocol: "tcp", port: 6380, primary: true }],
    listenerAuthority: { owner: "launcher", daemon: "Redis", port: 6380, setting: "--port 6380" },
  } as const;
  const plannedApp = {
    ...plan,
    id: AppId.make(kind === "global" ? "global" : kind === "scratch" ? "scratch-demo" : String(plan.id)),
    services: { [web.name]: service },
    extensions: kind === "scratch" ? { "@lando/core/scratch": {} } : {},
  };
  const provider = {
    ...TestRuntimeProvider,
    execStream: () =>
      Stream.make(
        {
          kind: "stdout" as const,
          chunk: new TextEncoder().encode(
            "sl local_address rem_address st tx_queue rx_queue tr tm->when retrnsmt uid timeout inode\n0: 00000000:18EB 00000000:0000 0A 0:0 0:0 0 0 0 1\n",
          ),
        },
        { exitCode: 1 },
      ),
  };
  const error = await Effect.runPromise(
    Effect.flip(
      failReadiness(
        { plan: plannedApp, service: web.name, provider },
        { reason: "healthcheck-failed", lastStatus: "missing readiness tool" },
      ),
    ),
  );
  expect(error.listener).toMatchObject({
    service: String(web.name),
    port: 6380,
    state: "not-listening",
    listening: [{ address: "0.0.0.0", port: 6379 }],
  });
  expect(error.lastStatus).toBe("missing readiness tool");
  expect(error.message).toContain("no TCP listener observed on 6380; observed ports: 6379");
  expect(error.remediation.split("\n").slice(0, 2)).toEqual([
    "Make web listen on 6380, or set `port: 6379` if that is the port it uses.",
    "Pass `--port 6380` to Redis in your command or entrypoint; Lando sets the listener from port: only in its own launcher.",
  ]);
  expect(error.remediation).toContain(
    kind === "global"
      ? "lando global:logs"
      : kind === "scratch"
        ? "lando scratch logs scratch-demo"
        : `lando logs -s ${web.name}`,
  );
});

test.each(["not-running", "inspect-failed"] as const)("%s never collects a listener", async (reason) => {
  let calls = 0;
  const provider = {
    ...TestRuntimeProvider,
    execStream: () => {
      calls += 1;
      return Stream.make({ exitCode: 0 });
    },
  };
  const error = await Effect.runPromise(
    Effect.flip(failReadiness({ plan, service: web.name, provider }, { reason })),
  );
  expect(error.listener).toBeUndefined();
  expect(calls).toBe(0);
});

test.each([
  {
    address: "0100007F",
    state: "loopback-only",
    finding: "only loopback TCP bindings observed on 6380",
    action: "Bind it to all interfaces (0.0.0.0) instead of loopback.",
  },
  {
    address: "00000000",
    state: "listening",
    finding: "TCP 6380 is bound, but readiness still failed",
    action: "Check the readiness command; its last output is under lastStatus.",
  },
])("timeout readiness reports $state conservatively", async ({ address, state, finding, action }) => {
  const service = {
    ...web,
    endpoints: [{ _tag: "internal", protocol: "tcp", port: 6380, primary: true }],
  } as const;
  const plannedApp = { ...plan, services: { [web.name]: service } };
  const provider = {
    ...TestRuntimeProvider,
    execStream: () =>
      Stream.make(
        {
          kind: "stdout" as const,
          chunk: new TextEncoder().encode(
            `sl local_address rem_address st tx_queue rx_queue tr tm->when retrnsmt uid timeout inode\n0: ${address}:18EC 00000000:0000 0A 0:0 0:0 0 0 0 1\n`,
          ),
        },
        { exitCode: 0 },
      ),
  };
  const error = await Effect.runPromise(
    Effect.flip(
      failReadiness({ plan: plannedApp, service: web.name, provider }, { reason: "healthcheck-timeout" }),
    ),
  );
  expect(error.listener?.state).toBe(state);
  expect(error.message).toContain(finding);
  expect(error.remediation).toStartWith(action);
});

test("collects listener evidence and logs concurrently without delaying the original failure", async () => {
  const service = {
    ...web,
    endpoints: [{ _tag: "internal", protocol: "tcp", port: 6380, primary: true }],
  } as const;
  const plannedApp = { ...plan, services: { [web.name]: service } };
  const provider = {
    ...TestRuntimeProvider,
    execStream: () => Stream.fromEffect(Effect.never),
    logs: () => Stream.fromEffect(Effect.never),
  };
  const timed = await runExitUnderClock(
    failReadiness({ plan: plannedApp, service: web.name, provider }, { reason: "healthcheck-failed" }),
    "4 seconds",
  );
  const error = failureOf(timed.exit);
  expect(timed.elapsedMs).toBe(4000);
  expect(error).toMatchObject({ _tag: "ServiceNotReadyError" });
  if (!(error instanceof ServiceNotReadyError)) throw new TypeError("Expected readiness error");
  expect(error.listener).toBeUndefined();
  expect(error.remediation).toContain("readiness: false disables startup readiness");
});

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
        publications: { status: "unknown" as const },
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
        publications: { status: "unknown" as const },
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
