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

const hist = (service: string, client: string, user = "default") =>
  `${HISTORY_MOUNT_TARGET}/${service}.${user}.${client}`;

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

  test("skips when history is disabled", () => {
    expect(
      withHistoryExecEnv({
        tty: true,
        serviceName: "appserver",
        hasHistoryMount: true,
        enabled: false,
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
      user: "mysql",
      hasHistoryMount: true,
    });
    expect(env?.HISTFILE).toBe(hist("db", "bash_history", "mysql"));
    expect(env?.MYSQL_HISTFILE).toBe(hist("db", "mysql_history", "mysql"));
    expect(env?.MARIADB_HISTFILE).toBe(hist("db", "mysql_history", "mysql"));
    expect(env?.PSQL_HISTORY).toBe(hist("db", "psql_history", "mysql"));
    expect(env?.REDISCLI_HISTFILE).toBe(hist("db", "redis_history", "mysql"));
    expect(env?.SQLITE_HISTORY).toBe(hist("db", "sqlite_history", "mysql"));
    expect(env?.NODE_REPL_HISTORY).toBe(hist("db", "node_history", "mysql"));
    expect(env?.PYTHON_HISTORY).toBe(hist("db", "python_history", "mysql"));
  });

  test("lets an existing service env var win", () => {
    const env = withHistoryExecEnv({
      tty: true,
      serviceName: "appserver",
      hasHistoryMount: true,
      serviceEnv: { HISTFILE: "/custom/hist" },
    });
    expect(env?.HISTFILE).toBeUndefined();
    expect(env?.MYSQL_HISTFILE).toBe(hist("appserver", "mysql_history"));
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
    expect(env?.MYSQL_HISTFILE).toBe(hist("appserver", "mysql_history"));
  });

  test("copies MYSQL_HISTFILE into MARIADB_HISTFILE when only MYSQL is set", () => {
    const env = withHistoryExecEnv({
      tty: true,
      serviceName: "db",
      hasHistoryMount: true,
      serviceEnv: { MYSQL_HISTFILE: "/custom/mysql" },
    });
    expect(env?.MYSQL_HISTFILE).toBeUndefined();
    expect(env?.MARIADB_HISTFILE).toBe("/custom/mysql");
  });

  test("injects neither MYSQL_HISTFILE nor MARIADB_HISTFILE when MARIADB is set", () => {
    const env = withHistoryExecEnv({
      tty: true,
      serviceName: "db",
      hasHistoryMount: true,
      serviceEnv: { MARIADB_HISTFILE: "/custom/mariadb" },
    });
    expect(env?.MARIADB_HISTFILE).toBeUndefined();
    expect(env?.MYSQL_HISTFILE).toBeUndefined();
  });

  test("injects neither MYSQL_HISTFILE nor MARIADB_HISTFILE when both are set", () => {
    const env = withHistoryExecEnv({
      tty: true,
      serviceName: "db",
      hasHistoryMount: true,
      serviceEnv: { MYSQL_HISTFILE: "/custom/mysql", MARIADB_HISTFILE: "/custom/mariadb" },
    });
    expect(env?.MYSQL_HISTFILE).toBeUndefined();
    expect(env?.MARIADB_HISTFILE).toBeUndefined();
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

  test("skips injection when history is disabled", async () => {
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
        enabled: false,
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
        target: { app: AppId.make("app"), service: ServiceName.make("web"), user: "www-data" },
        serviceName: "web",
        tty: true,
      }),
    );
    expect(env?.HISTFILE).toBe(hist("web", "bash_history", "www-data"));
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
