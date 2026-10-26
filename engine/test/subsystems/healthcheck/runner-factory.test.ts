import { describe, expect, test } from "bun:test";

import { RedactionService, makeRedactionService } from "@lando/redaction/service";
import { AppPlan } from "@lando/sdk/schema";
import type { RuntimeProviderShape } from "@lando/sdk/services";
import { TestRuntimeProvider } from "@lando/sdk/test";
import { Effect, Result, Schema } from "effect";

import { makeHealthcheckRunner } from "../../../src/subsystems/healthcheck/runner-factory.ts";
import { appId, commandPlan, drive, execSequence, nonePlan, service } from "./support.ts";

describe("makeHealthcheckRunner", () => {
  test("kind none resolves healthy without calling exec", async () => {
    const fake = execSequence([0]);
    const provider = { ...TestRuntimeProvider, exec: fake.exec } satisfies RuntimeProviderShape;

    const result = await drive(
      makeHealthcheckRunner({ exec: provider.exec }).run(nonePlan(), appId, service),
    );

    expect(result).toEqual({ healthy: true, service, attempts: 0, lastStatus: "skipped" });
    expect(fake.calls).toHaveLength(0);
  });

  test.each([
    { exitCode: 0, healthy: true, lastStatus: "ok" },
    { exitCode: 1, healthy: false, lastStatus: "exit 1" },
  ])("command exit $exitCode decides healthy=$healthy", async ({ exitCode, healthy, lastStatus }) => {
    const fake = execSequence([exitCode]);
    const provider = { ...TestRuntimeProvider, exec: fake.exec } satisfies RuntimeProviderShape;

    const result = await drive(
      makeHealthcheckRunner({ exec: provider.exec }).run(commandPlan(["health"]), appId, service),
    );

    expect(result).toMatchObject({ healthy, service, attempts: 1 });
    expect(result.lastStatus).toStartWith(lastStatus);
    expect(fake.calls).toHaveLength(1);
  });

  test("uses the provider-exec runner id", () => {
    const fake = execSequence([0]);
    const provider = { ...TestRuntimeProvider, exec: fake.exec } satisfies RuntimeProviderShape;

    const runner = makeHealthcheckRunner({ exec: provider.exec });

    expect(runner.id).toBe("provider-exec");
  });

  test("retains bounded safe failure evidence after redacting stderr", async () => {
    const redaction = makeRedactionService();
    const secret = "probe-canary-secret";
    const result = await drive(
      Effect.gen(function* () {
        yield* redaction.registerValues([secret]);
        return yield* makeHealthcheckRunner({
          exec: () =>
            Effect.succeed({
              exitCode: 42,
              stdout: "",
              stderr: `discarded-prefix${"x".repeat(4096)} protocol rejected ${secret}`,
            }),
        })
          .run(commandPlan(["check"]), appId, service)
          .pipe(Effect.provideService(RedactionService, redaction));
      }),
    );
    expect(result.healthy).toBe(false);
    expect(result.attempts).toBe(1);
    expect(result.lastStatus).toContain("exit 42; red; attempts 1; elapsed 0ms");
    expect(result.lastStatus).toContain("protocol rejected");
    expect(result.lastStatus).not.toContain(secret);
    expect(result.lastStatus).not.toContain("discarded-prefix");
    expect(result.lastStatus?.length).toBeLessThanOrEqual(2048);
  });

  test("distinguishes a missing executable from a listener or protocol rejection", async () => {
    const result = await drive(
      makeHealthcheckRunner({
        exec: () =>
          Effect.succeed({
            exitCode: 127,
            stdout: "",
            stderr: "mongosh: command not found",
          }),
      }).run(commandPlan(["mongosh"]), appId, service),
    );
    expect(result.healthy).toBe(false);
    expect(result.lastStatus).toContain("exit 127");
    expect(result.lastStatus).toContain("command not found");
    expect(result.lastStatus).not.toContain("authentication");
  });

  test("compiles the declared target through the public runner context and retains safe target evidence", async () => {
    const metadata = { resolvedAt: "2026-10-01T00:00:00Z", source: "probe", runtime: 4 };
    const appPlan = Schema.decodeUnknownSync(AppPlan)({
      id: appId,
      valueModel: 1,
      name: "probe",
      slug: "probe",
      root: "/tmp/probe",
      provider: "test",
      networks: [],
      routes: [],
      stores: [],
      fileSync: [],
      metadata,
      extensions: {},
      services: {
        [service]: {
          name: service,
          type: "mongodb",
          provider: "test",
          primary: false,
          environment: {},
          mounts: [],
          routes: [],
          dependsOn: [],
          hostAliases: [],
          extensions: {},
          metadata,
          endpoints: [{ _tag: "internal", port: 27017, protocol: "tcp" }],
        },
      },
    });
    const fake = execSequence([42]);
    const probe = {
      ...commandPlan(["mongo-ready"]),
      target: { port: 27017, transport: "tcp" as const, names: [], primary: false },
    };
    const result = await drive(makeHealthcheckRunner(fake).run(probe, appPlan.id, service, appPlan));
    expect(fake.calls[0]?.command.command).toEqual([
      "env",
      "LANDO_PROBE_HOST=web",
      "LANDO_PROBE_PORT=27017",
      "mongo-ready",
    ]);
    expect(result.healthy).toBe(false);
    expect(result.lastStatus).toContain("LANDO_PROBE_HOST=web LANDO_PROBE_PORT=27017");
    expect(result.lastStatus).toContain("exit 42");
  });

  test("fails a targeted public runner call without context before provider exec", async () => {
    const fake = execSequence([0]);
    const probe = {
      ...commandPlan(["mongo-ready"]),
      target: { port: 27017, transport: "tcp" as const, names: [], primary: false },
    };
    const result = await drive(Effect.result(makeHealthcheckRunner(fake).run(probe, appId, service)));
    expect(Result.isFailure(result)).toBe(true);
    if (Result.isFailure(result)) expect(result.failure._tag).toBe("HealthcheckError");
    expect(fake.calls).toHaveLength(0);
  });
});
