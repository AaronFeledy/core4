import { describe, expect, test } from "bun:test";
import {
  AbsolutePath,
  AppId,
  type AppPlan,
  ProviderId,
  ServiceName,
  type ServicePlan,
} from "@lando/sdk/schema";
import { DateTime } from "effect";

import { appSteps } from "../../src/services/build-app-plan.ts";

const metadata = {
  resolvedAt: DateTime.makeUnsafe("2026-11-15T00:00:00Z"),
  source: "test",
  runtime: 4 as const,
};

const service = (projectUser?: ServicePlan["projectUser"]): ServicePlan => ({
  name: ServiceName.make("web"),
  type: "php:8.3",
  provider: ProviderId.make("lando"),
  primary: true,
  environment: {},
  ...(projectUser === undefined ? {} : { projectUser }),
  home: { state: "persisted", target: "/var/www", store: "lando-home", user: "www-data" },
  mounts: [],
  endpoints: [],
  routes: [],
  dependsOn: [],
  hostAliases: [],
  metadata,
  extensions: {
    "@lando/core/service-features": {
      buildSteps: [{ id: "seed", phase: "app", command: { command: ["php", "app/console", "seed"] } }],
    },
  },
});

const plan = (web: ServicePlan): AppPlan => ({
  valueModel: 1,
  id: AppId.make("build-app-user"),
  name: "Build App User",
  slug: "build-app-user",
  root: AbsolutePath.make("/tmp/build-app-user"),
  provider: web.provider,
  services: { [web.name]: web },
  routes: [],
  stores: [],
  fileSync: [],
  metadata,
  extensions: {},
});

describe("build.app execution identity", () => {
  test("an app step defaults to the project user with its home", () => {
    const [step] = appSteps(plan(service({ name: "www-data", uid: 33, gid: 33 })));
    expect(step?.step.user).toBe("www-data");
    expect(step?.step.command).toEqual(["php", "app/console", "seed"]);
    expect(step?.command.env).toEqual({
      HOME: "/var/www",
      LANDO_USER: "www-data",
      LANDO_UID: "33",
      LANDO_GID: "33",
    });
  });

  test("a service without a project user keeps the image identity", () => {
    const steps = appSteps(plan(service()));
    expect(steps).toHaveLength(1);
    const [step] = steps;
    expect(step?.step.user).toBeUndefined();
    expect(step?.command.env).toBeUndefined();
  });

  test("an authored step user wins over the project user and keeps its own environment", () => {
    const web: ServicePlan = {
      ...service({ name: "www-data", uid: 33, gid: 33 }),
      extensions: {
        "@lando/core/service-features": {
          buildSteps: [
            {
              id: "seed",
              phase: "app",
              user: "root",
              command: { command: ["php", "app/console", "seed"] },
            },
          ],
        },
      },
    };
    const [step] = appSteps(plan(web));
    expect(step?.step.user).toBe("root");
    expect(step?.command.env).toBeUndefined();
  });

  test("an empty step user is not an identity and falls back to the project user", () => {
    const web: ServicePlan = {
      ...service({ name: "www-data", uid: 33, gid: 33 }),
      extensions: {
        "@lando/core/service-features": {
          buildSteps: [
            { id: "seed", phase: "app", user: "", command: { command: ["php", "app/console", "seed"] } },
          ],
        },
      },
    };
    const [step] = appSteps(plan(web));
    expect(step?.step.user).toBe("www-data");
    expect(step?.command.env).toMatchObject({ LANDO_USER: "www-data", LANDO_UID: "33" });
  });

  test("the mapping enters the step build key", () => {
    const [plain] = appSteps(plan(service()));
    const [mapped] = appSteps(plan(service({ name: "www-data", uid: 33, gid: 33 })));
    expect(mapped?.step.buildKey).not.toBe(plain?.step.buildKey);
  });

  test("a numeric project user runs with its authored primary gid", () => {
    const [step] = appSteps(plan(service({ name: "1000", uid: 1000, gid: 1001 })));
    expect(step?.step.user).toBe("1000:1001");
    expect(step?.command.env?.LANDO_USER).toBe("1000");
    expect(step?.command.env?.LANDO_GID).toBe("1001");
  });
});
