import { describe, expect, test } from "bun:test";
import { ServiceName, type ServicePlan } from "@lando/sdk/schema";
import { DateTime } from "effect";

import { projectUserEnvironment, selectCommandIdentity } from "../../src/services/execution-identity.ts";

const service = (overrides: Partial<ServicePlan> = {}): ServicePlan =>
  ({
    name: ServiceName.make("web"),
    type: "php:8.3",
    provider: "lando",
    primary: true,
    environment: {},
    home: { state: "persisted", target: "/var/www", store: "lando-app--home", user: "www-data" },
    mounts: [],
    endpoints: [],
    routes: [],
    dependsOn: [],
    hostAliases: [],
    metadata: { resolvedAt: DateTime.makeUnsafe("1970-01-01T00:00:00Z"), source: "test", runtime: 4 },
    extensions: {},
    ...overrides,
  }) as ServicePlan;

const projectUser = { name: "www-data", uid: 33, gid: 33 };

describe("selectCommandIdentity", () => {
  test("CLI --user wins over every lower precedence", () => {
    expect(
      selectCommandIdentity({
        cliUser: "root",
        stepUser: "node",
        taskUser: "www-data",
        service: service({ projectUser }),
      }),
    ).toEqual({ user: "root", environment: {} });
  });

  test("a step user wins over a task user and the project user", () => {
    expect(
      selectCommandIdentity({
        stepUser: "node",
        taskUser: "www-data",
        service: service({ projectUser }),
      }),
    ).toEqual({ user: "node", environment: {} });
  });

  test("a task user wins over the project user", () => {
    expect(selectCommandIdentity({ taskUser: "node", service: service({ projectUser }) })).toEqual({
      user: "node",
      environment: {},
    });
  });

  test("with no explicit identity the project user is used with its home and ids", () => {
    expect(selectCommandIdentity({ service: service({ projectUser }) })).toEqual({
      user: "www-data",
      environment: { HOME: "/var/www", LANDO_USER: "www-data", LANDO_UID: "33", LANDO_GID: "33" },
    });
  });

  test("a service without a project user keeps the container default", () => {
    expect(selectCommandIdentity({ service: service() })).toEqual({ environment: {} });
  });

  test("a numeric project user without a known home gets no HOME", () => {
    expect(
      selectCommandIdentity({
        service: service({
          projectUser: { name: "1000", uid: 1000, gid: 1001 },
          home: { state: "unknown", reason: "undeclared-user", user: "1000" },
        }),
      }),
    ).toEqual({
      user: "1000:1001",
      environment: { LANDO_USER: "1000", LANDO_UID: "1000", LANDO_GID: "1001" },
    });
  });

  test("a missing applied plan keeps the container default but an explicit user still applies", () => {
    expect(selectCommandIdentity({ service: undefined })).toEqual({ environment: {} });
    expect(selectCommandIdentity({ cliUser: "root", service: undefined })).toEqual({
      user: "root",
      environment: {},
    });
  });
});

describe("projectUserEnvironment", () => {
  test("an authored home mount still supplies HOME", () => {
    expect(
      projectUserEnvironment(
        service({
          projectUser,
          home: { state: "authored", target: "/home/www-data", mount: "volume" },
        }),
      ),
    ).toEqual({
      HOME: "/home/www-data",
      LANDO_USER: "www-data",
      LANDO_UID: "33",
      LANDO_GID: "33",
    });
  });
});
