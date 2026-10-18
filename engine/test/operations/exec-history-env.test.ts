import { describe, expect, test } from "bun:test";
import { DateTime, Effect, Option, Stream } from "effect";

import {
  AbsolutePath,
  AppId,
  type AppPlan,
  HISTORY_MOUNT_TARGET,
  ProviderId,
  ServiceName,
} from "@lando/sdk/schema";
import type {
  CommandSpec,
  ExecChunk,
  ExecTarget,
  RuntimeProviderShape,
  ServiceRuntimeInfo,
} from "@lando/sdk/services";
import { TestRuntimeProvider } from "@lando/sdk/test";

import { execServiceCommand } from "../../src/operations/exec.ts";

const providerId = ProviderId.make("lando");
const serviceName = ServiceName.make("web");
const metadata = {
  resolvedAt: DateTime.makeUnsafe("2026-10-18T00:00:00Z"),
  source: "exec-history-env.test",
  runtime: 4 as const,
};

const service = {
  name: serviceName,
  type: "php:8.3",
  provider: providerId,
  primary: true,
  artifact: { kind: "ref" as const, ref: "php:8.3-apache" },
  environment: {},
  mounts: [],
  storage: [],
  endpoints: [],
  routes: [],
  dependsOn: [],
  hostAliases: [],
  metadata,
  extensions: {},
};

const plan = {
  id: AppId.make("histapp"),
  name: "histapp",
  slug: "histapp",
  root: AbsolutePath.make("/tmp/histapp"),
  provider: providerId,
  services: { [serviceName]: service },
  routes: [],
  networks: [],
  stores: [],
  fileSync: [],
  metadata,
  extensions: {},
} as AppPlan;

const historyRuntime = (mounts: ReadonlyArray<string>): ServiceRuntimeInfo => ({
  app: plan.id,
  service: serviceName,
  providerId,
  status: "running",
  mountDestinations: [...mounts],
});

const recordingProvider = (runtime: ServiceRuntimeInfo) => {
  let env: Record<string, string> | undefined;
  const provider: RuntimeProviderShape = {
    ...TestRuntimeProvider,
    id: providerId,
    inspect: () => Effect.succeed(runtime),
    execStream: (_target: ExecTarget, command: CommandSpec) => {
      env = command.env === undefined ? undefined : { ...command.env };
      return Stream.fromIterable<ExecChunk>([{ exitCode: 0 }]);
    },
  };
  return {
    provider,
    env: () => env,
  };
};

describe("execServiceCommand history env", () => {
  test("calls mergeHistoryExecEnv and injects HISTFILE for a TTY with the mount", async () => {
    const recorded = recordingProvider(historyRuntime([HISTORY_MOUNT_TARGET]));
    await Effect.runPromise(
      execServiceCommand(
        {
          provider: recorded.provider,
          target: { app: plan.id, service: serviceName, plan, user: "www-data" },
          service,
          options: { command: ["bash"], tty: true, user: "www-data" },
        },
        Option.none(),
      ),
    );
    expect(recorded.env()?.HISTFILE).toBe(`${HISTORY_MOUNT_TARGET}/web.www-data.bash_history`);
  });

  test("does not inject HISTFILE without a TTY", async () => {
    const recorded = recordingProvider(historyRuntime([HISTORY_MOUNT_TARGET]));
    await Effect.runPromise(
      execServiceCommand(
        {
          provider: recorded.provider,
          target: { app: plan.id, service: serviceName, plan },
          service,
          options: { command: ["ls"], tty: false },
        },
        Option.none(),
      ),
    );
    expect(recorded.env()?.HISTFILE).toBeUndefined();
  });
});
