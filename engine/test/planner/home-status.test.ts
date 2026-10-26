import { expect, test } from "bun:test";
import { LandofileValidationError } from "@lando/sdk/errors";
import { ServiceConfig, ServicePlan } from "@lando/sdk/schema";
import type { ServiceImageIdentity } from "@lando/sdk/services";
import { Schema } from "effect";
import {
  applyServiceHome,
  hasCustomImage,
  homeStoreName,
  serviceHomeIntent,
} from "../../src/planner/home.ts";

const identity: ServiceImageIdentity = { defaultUser: "root", homes: { root: "/root", node: "/home/node" } };
const basePlan = Schema.decodeUnknownSync(ServicePlan)({
  name: "web",
  type: "node:22",
  provider: "test",
  primary: true,
  environment: {},
  mounts: [],
  storage: [],
  endpoints: [],
  routes: [],
  dependsOn: [],
  hostAliases: [],
  metadata: { resolvedAt: "2026-01-01T00:00:00Z", source: "test", runtime: 4 },
  extensions: {},
});

test.each([
  [
    {},
    undefined,
    { state: "persisted", target: "/root", user: "root", store: homeStoreName("app", "web", "root") },
  ],
  [
    { home: { path: "/chosen" } },
    "node:staff",
    { state: "persisted", target: "/chosen", user: "node", store: homeStoreName("app", "web", "node") },
  ],
  [
    { image: "custom/image", home: { path: "/chosen" } },
    undefined,
    { state: "persisted", target: "/chosen", store: homeStoreName("app", "web") },
  ],
  [{ home: false }, undefined, { state: "disabled" }],
  [{ image: "custom/image" }, "node", { state: "unknown", reason: "custom-image", user: "node" }],
  [{}, "nobody:staff", { state: "unknown", reason: "undeclared-user", user: "nobody" }],
] as const)("sets home status for %j and planned user %s", (config, plannedUser, expected) => {
  const result = applyServiceHome({
    servicePlan: { ...basePlan, ...(plannedUser === undefined ? {} : { user: plannedUser }) },
    serviceName: "web",
    appSlug: "app",
    appRoot: "/tmp/app",
    intent: serviceHomeIntent({
      service: Schema.decodeUnknownSync(ServiceConfig)(config),
      serviceTypeId: "node:22",
      identity,
    }),
  });
  expect(result).not.toBeInstanceOf(LandofileValidationError);
  if (result instanceof LandofileValidationError) return;
  expect(result.home).toEqual(expected);
  expect(result.storage).toHaveLength(expected.state === "persisted" ? 1 : 0);
});

test("sets unknown no-identity instead of guessing a home", () => {
  const result = applyServiceHome({
    servicePlan: basePlan,
    serviceName: "web",
    appSlug: "app",
    appRoot: "/tmp/app",
    intent: serviceHomeIntent({
      service: Schema.decodeUnknownSync(ServiceConfig)({}),
      serviceTypeId: "lando",
      identity: undefined,
    }),
  });
  expect(result).toMatchObject({ home: { state: "unknown", reason: "no-identity" }, storage: [] });
});

test.each([undefined, "10001:10001"])(
  "persists an explicit path without catalog identity for user %s",
  (user) => {
    const result = applyServiceHome({
      servicePlan: { ...basePlan, ...(user === undefined ? {} : { user }) },
      serviceName: "web",
      appSlug: "app",
      appRoot: "/tmp/app",
      intent: serviceHomeIntent({
        service: Schema.decodeUnknownSync(ServiceConfig)({ home: { path: "/chosen" } }),
        serviceTypeId: "lando",
        identity: undefined,
      }),
    });
    expect(result).toMatchObject({
      home: {
        state: "persisted",
        target: "/chosen",
        store: homeStoreName("app", "web", user === undefined ? undefined : "10001"),
        ...(user === undefined ? {} : { user: "10001" }),
      },
    });
  },
);

test.each([
  ["storage", { storage: [{ store: "mine", target: "/home/./node/", readOnly: false }] }, "volume"],
  [
    "bind",
    {
      mounts: [
        {
          type: "bind",
          source: "/tmp/home",
          target: "/home//node/",
          readOnly: false,
          realization: "passthrough",
        },
      ],
    },
    "bind",
  ],
  [
    "volume",
    {
      mounts: [
        { type: "volume", source: "mine", target: "/home/node", readOnly: false, realization: "passthrough" },
      ],
    },
    "volume",
  ],
  [
    "tmpfs mount",
    { mounts: [{ type: "tmpfs", target: "/home/node", readOnly: false, realization: "passthrough" }] },
    "tmpfs",
  ],
  [
    "appMount",
    {
      appMount: {
        source: "/tmp/app",
        target: "/home/other/../node",
        readOnly: false,
        excludes: [],
        includes: [],
        realization: "passthrough",
      },
    },
    "bind",
  ],
  ["tmpfs option", { extensions: { compose: { tmpfs: ["/home/node/:rw,size=1m"] } } }, "tmpfs"],
] as const)("keeps authored %s at the canonical home target", (_name, overrides, mount) => {
  const servicePlan = Schema.decodeUnknownSync(ServicePlan)({
    ...Schema.encodeSync(ServicePlan)(basePlan),
    user: "node",
    ...overrides,
  });
  const result = applyServiceHome({
    servicePlan,
    serviceName: "web",
    appSlug: "app",
    appRoot: "/tmp/app",
    intent: { serviceType: "node:22", identity },
  });
  expect(result).toMatchObject({ home: { state: "authored", target: "/home/node", mount } });
  if (!(result instanceof LandofileValidationError)) expect(result.storage).toEqual(servicePlan.storage);
});

test("does not treat parent or child mounts as the exact home target", () => {
  const servicePlan = Schema.decodeUnknownSync(ServicePlan)({
    ...Schema.encodeSync(ServicePlan)(basePlan),
    user: "node",
    mounts: [
      { type: "tmpfs", target: "/home", readOnly: false, realization: "passthrough" },
      { type: "tmpfs", target: "/home/node/cache", readOnly: false, realization: "passthrough" },
    ],
  });
  const result = applyServiceHome({
    servicePlan,
    serviceName: "web",
    appSlug: "app",
    appRoot: "/tmp/app",
    intent: { serviceType: "node:22", identity },
  });
  expect(result).toMatchObject({ home: { state: "persisted", target: "/home/node" } });
});

test("distinguishes catalog Hub aliases from custom images", () => {
  const config = Schema.decodeUnknownSync(ServiceConfig)({ image: "index.docker.io/library/node:22" });
  expect(hasCustomImage(config, "node:22")).toBe(false);
  expect(hasCustomImage(config, "ghcr.io/library/node:22")).toBe(true);
});

test("uses per-principal digests that separate ambiguous service/user pairs", () => {
  expect(homeStoreName("app", "web", "root")).toBe("lando-app-web-home-root-3177abf4");
  expect(homeStoreName("app", "a-b", "c")).toBe("lando-app-a-b-home-c-695274f6");
  expect(homeStoreName("app", "a", "b-c")).toBe("lando-app-a-home-b-c-02654a5c");
  expect(homeStoreName("app", "a-b", "c")).not.toBe(homeStoreName("app", "a", "b-c"));
  expect(homeStoreName("app", "web", "Root")).toMatch(/^lando-app-web-home-root-[a-f0-9]{8}$/u);
  expect(homeStoreName("app", "web", "Root")).not.toBe(homeStoreName("app", "web", "root"));
  expect(homeStoreName("app", "web", "--User A--")).toMatch(/^lando-app-web-home-user-a-[a-f0-9]{8}$/u);
  expect(homeStoreName("app", "web", "a".repeat(40))).toMatch(/^lando-app-web-home-a{32}-[a-f0-9]{8}$/u);
  expect(homeStoreName("app", "web")).toBe("lando-app-web-home");
});
