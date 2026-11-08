import { expect, test } from "bun:test";
import { ServiceName } from "@lando/sdk/schema";
import { web } from "./start-progress-topology-support.ts";
import { paths, previousHome, runNotice, runTransition, withHome } from "./volume-transition-support.ts";

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
    expect(appliedReads).toBe(path === "selected restart" ? 1 : 0);
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
