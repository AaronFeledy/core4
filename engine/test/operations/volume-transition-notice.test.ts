import { expect, test } from "bun:test";
import {
  type AppPlan,
  type BindMountPlan,
  type MountPlan,
  PortablePath,
  ServiceName,
} from "@lando/sdk/schema";
import { SERVICE_FEATURES_EXTENSION_KEY } from "../../src/planner/extensions.ts";
import { plan, web } from "./start-progress-topology-support.ts";
import { paths, previousHome, runNotice, runTransition, withHome } from "./volume-transition-support.ts";

const bindMount: BindMountPlan = {
  type: "bind",
  source: plan.root,
  target: PortablePath.make("/app"),
  readOnly: false,
  realization: "passthrough",
};
const appMount = { ...bindMount, role: "app" } as const;
const vendorShadow = {
  type: "volume",
  origin: "derived",
  store: "lando-test-web-shadow-vendor",
  target: PortablePath.make("/app/vendor"),
  readOnly: false,
} as const satisfies MountPlan;
const withMounts = (...mounts: readonly MountPlan[]): AppPlan => ({
  ...plan,
  services: { [web.name]: { ...web, mounts } },
});
const shadowedVendor = withMounts({ ...appMount, excludes: ["vendor"] }, vendorShadow);

test.each([
  ["removed exclude", appMount],
  ["authored include", { ...appMount, excludes: ["vendor"], includes: ["vendor"] }],
] as const)("rebuild warns once before apply when a %s exposes vendor", async (_change, bind) => {
  const { warnings, timeline, appliedReads } = await runTransition(
    "rebuild",
    shadowedVendor,
    withMounts(bind),
  );
  expect(warnings).toHaveLength(1);
  expect(warnings[0]?.body).toContain(`Service ${web.name} `);
  expect(warnings[0]?.body).toContain(vendorShadow.target);
  expect(warnings[0]?.body).toContain(vendorShadow.store);
  expect(timeline.indexOf("warn")).toBeLessThan(timeline.indexOf("apply"));
  expect(appliedReads).toBe(0);
});

test.each([
  ["app", false],
  ["build", true],
] as const)("a removed shadow keeps the warning with a %s-phase step", async (phase, advisesReinstall) => {
  const desired = {
    ...plan,
    services: {
      [web.name]: {
        ...web,
        mounts: [appMount],
        extensions: {
          [SERVICE_FEATURES_EXTENSION_KEY]: {
            buildSteps: [{ id: "install", phase, command: { command: ["install"] } }],
          },
        },
      },
    },
  };
  const warnings = await runNotice(shadowedVendor, desired);
  expect(warnings).toHaveLength(1);
  const body = warnings[0]?.body ?? "";
  expect(body).toContain(
    `Lando left ${vendorShadow.store} untouched and did not copy its contents to the host.`,
  );
  expect(body.includes("Rerun the dependency install or other setup the service needs there.")).toBe(
    advisesReinstall,
  );
  expect(body).not.toContain("lando rebuild");
});

test.each([
  ["authored storage", withMounts(appMount, { ...vendorShadow, origin: "authored", store: "custom" })],
  ["a different derived store", withMounts(appMount, { ...vendorShadow, store: "dependency-environment" })],
  ["tmpfs", withMounts(appMount, { type: "tmpfs", target: vendorShadow.target, readOnly: false })],
  ["authored bind", withMounts(appMount, { ...bindMount, origin: "authored", target: vendorShadow.target })],
  ["unchanged shadow", shadowedVendor],
  ["a still-excluded path without a desired shadow", withMounts({ ...appMount, excludes: ["vendor"] })],
  ["app mount removed", withMounts()],
  ["app mount moved", withMounts({ ...appMount, target: PortablePath.make("/other") })],
  ["service removed", { ...plan, services: {} }],
] as const)("a vendor shadow does not warn with %s", async (_change, desired) => {
  expect(await runNotice(shadowedVendor, desired)).toEqual([]);
});

test("a removed nested include bind does not warn", async () => {
  const include = {
    ...bindMount,
    origin: "derived",
    target: PortablePath.make("/app/vendor/acme"),
  } as const;
  expect(await runNotice(withMounts(appMount, vendorShadow, include), shadowedVendor)).toEqual([]);
});

test("a desired mount between the app bind and a removed nested shadow suppresses the notice", async () => {
  const nestedShadow = { ...vendorShadow, target: PortablePath.make("/app/vendor/acme") };
  const previous = withMounts({ ...appMount, excludes: ["vendor/acme"] }, nestedShadow);
  const desired = withMounts(appMount, { ...bindMount, origin: "authored", target: vendorShadow.target });
  expect(await runNotice(previous, desired)).toEqual([]);
});

test("selected restart warns once before apply when the selected service's vendor shadow is removed", async () => {
  const { warnings, timeline } = await runTransition(
    "selected restart",
    shadowedVendor,
    withMounts(appMount),
  );
  expect(warnings).toHaveLength(1);
  expect(warnings[0]?.body).toContain(vendorShadow.target);
  expect(warnings[0]?.body).toContain(vendorShadow.store);
  expect(timeline.indexOf("warn")).toBeLessThan(timeline.indexOf("apply"));
});

test("selected rebuild ignores a removed vendor shadow on an unselected service", async () => {
  const extra = ServiceName.make("extra");
  const previous = {
    ...plan,
    services: { [web.name]: web, [extra]: { ...web, name: extra, mounts: [appMount, vendorShadow] } },
  };
  const desired = {
    ...plan,
    services: { [web.name]: web, [extra]: { ...web, name: extra, mounts: [appMount] } },
  };
  expect((await runTransition("selected rebuild", previous, desired)).warnings).toEqual([]);
});

for (const path of paths) {
  test.each([
    { state: "unknown", reason: "custom-image" },
    { state: "unknown", reason: "no-identity" },
    { state: "unknown", reason: "undeclared-user", user: "alice" },
    { ...previousHome, store: "new-home" },
    { ...previousHome, target: "/new-home" },
  ] as const)(`${path} warns once before apply for %j`, async (home) => {
    // Given an applied persisted home and changed desired home metadata.
    const previous = withHome(previousHome);
    // When the command applies the desired plan, including any delegated start.
    const { warnings, timeline, appliedReads } = await runTransition(path, previous, withHome(home));
    // Then one warning names the old volume and an exact, parseable reattachment declaration.
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.body).toContain(
      'storage: [{ store: "lando-test-web-home-node-old", target: "/home/node" }]',
    );
    expect(warnings[0]?.body).toContain("services.web");
    if (home.state === "persisted") {
      expect(warnings[0]?.body).toContain(home.store);
      expect(warnings[0]?.body).toContain(home.target);
    }
    expect(timeline.indexOf("warn")).toBeLessThan(timeline.indexOf("apply"));
    expect(appliedReads).toBe(0);
  });

  test.each([
    [previousHome, { state: "disabled" }],
    [previousHome, { state: "authored", target: "/home/node", mount: "volume" }],
    [previousHome, { state: "authored", target: "/home/node", mount: "bind" }],
    [previousHome, { state: "authored", target: "/home/node", mount: "tmpfs" }],
    [previousHome, previousHome],
    [undefined, { state: "unknown", reason: "custom-image" }],
    [{ state: "unknown", reason: "custom-image" }, previousHome],
  ] as const)(`${path} stays quiet for %j -> %j`, async (old, home) => {
    // Given an intentional, unchanged, older, or newly persisted home.
    const previous = withHome(old);
    // When applying the command.
    const { warnings } = await runTransition(path, previous, withHome(home));
    // Then no transition warning is emitted.
    expect(warnings).toEqual([]);
  });

  test(`${path} ignores removed services and unselected changes`, async () => {
    // Given a removed service and an additional service whose home changes only outside a selection.
    const extra = ServiceName.make("extra");
    const removed = ServiceName.make("removed");
    const previous = {
      ...withHome(previousHome),
      services: {
        ...withHome(previousHome).services,
        [removed]: { ...web, name: removed, home: previousHome },
        [extra]: { ...web, name: extra, home: previousHome },
      },
    };
    const desired = {
      ...withHome(previousHome),
      services: {
        ...withHome(previousHome).services,
        [extra]: { ...web, name: extra, home: { state: "disabled" as const } },
      },
    };
    // When the command runs, then neither explicit intent nor removal warns.
    expect((await runTransition(path, previous, desired)).warnings).toEqual([]);
  });
}

test("home type changes omit the reattachment declaration", async () => {
  const previous = withHome(previousHome);
  const desired = withHome({ state: "unknown", reason: "custom-image" });
  const warnings = await runNotice(previous, {
    ...desired,
    services: { [web.name]: { ...web, type: "compose", home: { state: "unknown", reason: "custom-image" } } },
  });
  expect(warnings).toHaveLength(1);
  expect(warnings[0]?.body).toContain(previousHome.store);
  expect(warnings[0]?.body).toContain(previousHome.target);
  expect(warnings[0]?.body).not.toContain("storage:");
});

test.each(["start", "rebuild", "restart"] as const)(
  "%s warns once for each affected service",
  async (path) => {
    // Given two services losing automatic homes in the same command.
    const extra = ServiceName.make("extra");
    const previous = {
      ...withHome(previousHome),
      services: {
        ...withHome(previousHome).services,
        [extra]: { ...web, name: extra, home: previousHome },
      },
    };
    const desired = {
      ...withHome({ state: "unknown", reason: "custom-image" }),
      services: {
        ...withHome({ state: "unknown", reason: "custom-image" }).services,
        [extra]: { ...web, name: extra, home: { state: "unknown" as const, reason: "no-identity" as const } },
      },
    };
    // When the command runs, then each affected service is named exactly once.
    const { warnings } = await runTransition(path, previous, desired);
    expect(warnings).toHaveLength(2);
    expect(warnings.filter((event) => event.body.startsWith("Service web "))).toHaveLength(1);
    expect(warnings.filter((event) => event.body.startsWith("Service extra "))).toHaveLength(1);
  },
);

test.each(["start", "rebuild", "selected rebuild", "restart"] as const)(
  "%s stays quiet without an applied plan",
  async (path) => {
    // Given first application of a service with an unknown home.
    const desired = withHome({ state: "unknown", reason: "custom-image" });
    // When running the command, then no previous persisted home is invented.
    expect((await runTransition(path, undefined, desired)).warnings).toEqual([]);
  },
);

test("nested start deduplicates within a command but does not suppress a later command", async () => {
  // Given two separate rebuild commands sharing one caller fiber.
  const desired = withHome({ state: "unknown", reason: "custom-image" });
  // When both commands run and each delegates to start.
  const { warnings } = await runTransition("rebuild", withHome(previousHome), desired, 2);
  // Then each command emits exactly one notice, not zero or two per command.
  expect(warnings).toHaveLength(2);
});

test.each(["selected rebuild", "selected restart"] as const)(
  "%s ignores unselected automatic-home changes",
  async (path) => {
    // Given a changed home on an unselected service only.
    const extra = ServiceName.make("extra");
    const previous = {
      ...withHome(previousHome),
      services: {
        ...withHome(previousHome).services,
        [extra]: { ...web, name: extra, home: previousHome },
      },
    };
    const desired = {
      ...withHome(previousHome),
      services: {
        ...withHome(previousHome).services,
        [extra]: {
          ...web,
          name: extra,
          home: { state: "unknown" as const, reason: "custom-image" as const },
        },
      },
    };
    // When applying only web, then extra's unrealized change does not warn.
    expect((await runTransition(path, previous, desired)).warnings).toEqual([]);
  },
);
