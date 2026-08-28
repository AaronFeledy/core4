import { describe, expect, test } from "bun:test";

import { DateTime, Effect, Exit, Layer, Stream } from "effect";

import { CapabilityError, ToolingExecError } from "@lando/sdk/errors";
import { AbsolutePath, AppId, type AppPlan, ProviderId, ServiceName } from "@lando/sdk/schema";
import {
  type LogChunk,
  type LogOptions,
  type LogTarget,
  RuntimeProviderRegistry,
  type RuntimeProviderShape,
} from "@lando/sdk/services";
import { TestRuntimeProvider } from "@lando/sdk/test";

import { logsForPlan } from "../../src/operations/logs.ts";

const providerId = ProviderId.make("test");
const appId = AppId.make("logs-plan-app");
const web = ServiceName.make("web");
const database = ServiceName.make("database");

const metadata = {
  resolvedAt: DateTime.unsafeMake("2026-08-21T00:00:00Z"),
  source: "logs-test",
  runtime: 4 as const,
};

const makeService = (name: ServiceName) => ({
  name,
  type: "node",
  provider: providerId,
  primary: name === web,
  artifact: { kind: "ref" as const, ref: "node:22-alpine" },
  command: ["node", "-e", "console.log('ready')"],
  environment: {},
  mounts: [],
  storage: [],
  endpoints: [],
  routes: [],
  dependsOn: [],
  hostAliases: [],
  metadata,
  extensions: {},
});

const plan: AppPlan = {
  id: appId,
  name: "Logs Plan App",
  slug: "logs-plan-app",
  root: AbsolutePath.make("/tmp/lando-logs-plan-app"),
  provider: providerId,
  services: {
    [web]: makeService(web),
    [database]: makeService(database),
  },
  routes: [],
  networks: [],
  stores: [],
  fileSync: [],
  metadata,
  extensions: {},
};

const recordingProvider = (): {
  readonly calls: Array<{
    readonly target: LogTarget;
    readonly options: LogOptions;
  }>;
  readonly provider: RuntimeProviderShape;
} => {
  const calls: Array<{
    readonly target: LogTarget;
    readonly options: LogOptions;
  }> = [];
  const provider: RuntimeProviderShape = {
    ...TestRuntimeProvider,
    logs: (target, options) => {
      calls.push({ target, options });
      const chunk: LogChunk = {
        service: target.service,
        stream: "stdout",
        line: `${String(target.service)} ready`,
      };
      return Stream.make(chunk);
    },
  };
  return { calls, provider };
};

const provide = (provider: RuntimeProviderShape) =>
  Layer.succeed(RuntimeProviderRegistry, {
    list: Effect.succeed([providerId]),
    capabilities: Effect.succeed(provider.capabilities),
    select: () => Effect.succeed(provider),
  });

describe("logsForPlan", () => {
  test("passes the app plan into provider logs for each service", async () => {
    const { calls, provider } = recordingProvider();
    const result = await Effect.runPromise(logsForPlan(plan, {}).pipe(Effect.provide(provide(provider))));

    expect(result.app).toBe("Logs Plan App");
    expect(result.lines.map((line) => line.service)).toEqual(["web", "database"]);
    expect(calls.map((call) => String(call.target.service))).toEqual(["web", "database"]);
    expect(calls.every((call) => call.target.plan === plan)).toBe(true);
    expect(calls.every((call) => call.options.follow === false)).toBe(true);
  });

  test("forwards service, tail, and since to the provider", async () => {
    const { calls, provider } = recordingProvider();
    await Effect.runPromise(
      logsForPlan(plan, { service: "database", tail: 20, since: "15m" }).pipe(
        Effect.provide(provide(provider)),
      ),
    );

    expect(calls).toHaveLength(1);
    expect(String(calls[0]?.target.service)).toBe("database");
    expect(calls[0]?.target.plan).toBe(plan);
    expect(calls[0]?.options.follow).toBe(false);
    expect(calls[0]?.options.tail).toBe(20);
    expect(calls[0]?.options.since).toMatch(/^\d+$/u);
  });

  test("rejects an unknown service without calling the provider", async () => {
    const { calls, provider } = recordingProvider();
    const exit = await Effect.runPromiseExit(
      logsForPlan(plan, { service: "missing" }).pipe(Effect.provide(provide(provider))),
    );

    expect(Exit.isFailure(exit)).toBe(true);
    if (exit._tag === "Failure" && exit.cause._tag === "Fail") {
      expect(exit.cause.error).toBeInstanceOf(ToolingExecError);
      if (!(exit.cause.error instanceof ToolingExecError)) return;
      expect(exit.cause.error.message).toContain("missing");
      expect(exit.cause.error.message).toContain("database");
      expect(exit.cause.error.remediation).toBe("Example: lando logs --service database");
    }
    expect(calls).toEqual([]);
  });

  test("fails when the provider does not advertise serviceLogs", async () => {
    const provider: RuntimeProviderShape = {
      ...TestRuntimeProvider,
      capabilities: { ...TestRuntimeProvider.capabilities, serviceLogs: false },
    };
    const exit = await Effect.runPromiseExit(logsForPlan(plan).pipe(Effect.provide(provide(provider))));

    expect(exit._tag).toBe("Failure");
    if (exit._tag === "Failure" && exit.cause._tag === "Fail") {
      expect(exit.cause.error).toBeInstanceOf(CapabilityError);
      expect(exit.cause.error).toMatchObject({ capability: "serviceLogs" });
    }
  });
});
