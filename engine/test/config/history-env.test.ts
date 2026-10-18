import { describe, expect, test } from "bun:test";
import { Effect } from "effect";

import { AppId, HISTORY_MOUNT_TARGET, ProviderId, ServiceName } from "@lando/sdk/schema";
import type { RuntimeProviderShape, ServiceRuntimeInfo } from "@lando/sdk/services";

import {
  containerHasHistoryMount,
  mergeHistoryExecEnv,
  withHistoryExecEnv,
} from "../../src/config/history-env.ts";

const inspectProvider = (runtime: ServiceRuntimeInfo | undefined, fail = false): RuntimeProviderShape =>
  ({
    inspect: () => (fail ? Effect.fail(new Error("inspect failed")) : Effect.succeed(runtime)),
  }) as unknown as RuntimeProviderShape;

describe("withHistoryExecEnv", () => {
  test("skips non-TTY sessions", () => {
    expect(
      withHistoryExecEnv({
        tty: false,
        serviceName: "appserver",
        hasHistoryMount: true,
        env: { FOO: "1" },
      }),
    ).toEqual({ FOO: "1" });
  });

  test("skips when the running container has no history mount", () => {
    const env = withHistoryExecEnv({
      tty: true,
      serviceName: "appserver",
      hasHistoryMount: false,
    });
    expect(env).toBeUndefined();
  });

  test("injects histfile vars for a TTY session with the mount", () => {
    const env = withHistoryExecEnv({
      tty: true,
      serviceName: "db",
      hasHistoryMount: true,
    });
    expect(env?.HISTFILE).toBe(`${HISTORY_MOUNT_TARGET}/db.bash_history`);
    expect(env?.MYSQL_HISTFILE).toBe(`${HISTORY_MOUNT_TARGET}/db.mysql_history`);
    expect(env?.MARIADB_HISTFILE).toBe(`${HISTORY_MOUNT_TARGET}/db.mysql_history`);
    expect(env?.PSQL_HISTORY).toBe(`${HISTORY_MOUNT_TARGET}/db.psql_history`);
    expect(env?.REDISCLI_HISTFILE).toBe(`${HISTORY_MOUNT_TARGET}/db.redis_history`);
    expect(env?.SQLITE_HISTORY).toBe(`${HISTORY_MOUNT_TARGET}/db.sqlite_history`);
    expect(env?.NODE_REPL_HISTORY).toBe(`${HISTORY_MOUNT_TARGET}/db.node_history`);
    expect(env?.PYTHON_HISTORY).toBe(`${HISTORY_MOUNT_TARGET}/db.python_history`);
  });

  test("lets an existing service env var win", () => {
    const env = withHistoryExecEnv({
      tty: true,
      serviceName: "appserver",
      hasHistoryMount: true,
      serviceEnv: { HISTFILE: "/custom/hist" },
    });
    expect(env?.HISTFILE).toBeUndefined();
    expect(env?.MYSQL_HISTFILE).toBe(`${HISTORY_MOUNT_TARGET}/appserver.mysql_history`);
  });

  test("lets an explicit exec env var win", () => {
    const env = withHistoryExecEnv({
      tty: true,
      serviceName: "appserver",
      hasHistoryMount: true,
      env: { HISTFILE: "/explicit/hist", FOO: "1" },
    });
    expect(env?.HISTFILE).toBe("/explicit/hist");
    expect(env?.FOO).toBe("1");
    expect(env?.MYSQL_HISTFILE).toBe(`${HISTORY_MOUNT_TARGET}/appserver.mysql_history`);
  });

  test("unsets MARIADB_HISTFILE before setting MYSQL_HISTFILE", () => {
    const env = withHistoryExecEnv({
      tty: true,
      serviceName: "db",
      hasHistoryMount: true,
    });
    expect(Object.keys(env ?? {}).indexOf("MARIADB_HISTFILE")).toBeGreaterThanOrEqual(0);
    expect(env?.MARIADB_HISTFILE).toBe(`${HISTORY_MOUNT_TARGET}/db.mysql_history`);
    expect(env?.MYSQL_HISTFILE).toBe(`${HISTORY_MOUNT_TARGET}/db.mysql_history`);
  });

  test("does not unset MARIADB_HISTFILE when the service already sets it", () => {
    const env = withHistoryExecEnv({
      tty: true,
      serviceName: "db",
      hasHistoryMount: true,
      serviceEnv: { MARIADB_HISTFILE: "/custom/mariadb" },
    });
    expect(env?.MARIADB_HISTFILE).toBeUndefined();
    expect(env?.MYSQL_HISTFILE).toBe(`${HISTORY_MOUNT_TARGET}/db.mysql_history`);
  });
});

describe("mergeHistoryExecEnv", () => {
  test("skips silently when inspect fails", async () => {
    const env = await Effect.runPromise(
      mergeHistoryExecEnv({
        provider: inspectProvider(undefined, true),
        target: { app: AppId.make("app"), service: ServiceName.make("web") },
        serviceName: "web",
        tty: true,
      }),
    );
    expect(env).toBeUndefined();
  });

  test("injects when inspect reports the history mount", async () => {
    const env = await Effect.runPromise(
      mergeHistoryExecEnv({
        provider: inspectProvider({
          app: AppId.make("app"),
          service: ServiceName.make("web"),
          providerId: ProviderId.make("test"),
          status: "running",
          mountDestinations: [HISTORY_MOUNT_TARGET],
        }),
        target: { app: AppId.make("app"), service: ServiceName.make("web") },
        serviceName: "web",
        tty: true,
      }),
    );
    expect(env?.HISTFILE).toBe(`${HISTORY_MOUNT_TARGET}/web.bash_history`);
  });
});

test("containerHasHistoryMount reads inspect destinations", () => {
  expect(containerHasHistoryMount(undefined)).toBe(false);
  expect(
    containerHasHistoryMount({
      app: AppId.make("app"),
      service: ServiceName.make("web"),
      providerId: ProviderId.make("test"),
      status: "running",
      mountDestinations: ["/app"],
    }),
  ).toBe(false);
  expect(
    containerHasHistoryMount({
      app: AppId.make("app"),
      service: ServiceName.make("web"),
      providerId: ProviderId.make("test"),
      status: "running",
      mountDestinations: [HISTORY_MOUNT_TARGET],
    }),
  ).toBe(true);
});
