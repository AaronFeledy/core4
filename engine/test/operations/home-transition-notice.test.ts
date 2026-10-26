import { expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import type { AppPlan, ServiceHomePlan } from "@lando/sdk/schema";
import { ServiceName } from "@lando/sdk/schema";
import { RuntimeProviderRegistry } from "@lando/sdk/services";
import { Effect } from "effect";
import { rebuildApp } from "../../src/operations/rebuild.ts";
import { restartApp } from "../../src/operations/restart.ts";
import { startApp } from "../../src/operations/start.ts";
import { byTag, makeHarness, plan, web } from "./start-progress-topology-support.ts";

const previousHome = {
  state: "persisted",
  target: "/home/node",
  store: "lando-test-web-home-node-old",
  user: "node",
} as const;
const withHome = (home?: ServiceHomePlan): AppPlan => ({
  ...plan,
  services: { [web.name]: { ...web, ...(home === undefined ? {} : { home }) } },
});
const paths = ["start", "rebuild", "selected rebuild", "restart", "selected restart"] as const;
type CommandPath = (typeof paths)[number];

const runTransition = async (
  path: CommandPath,
  previous: AppPlan | undefined,
  desired: AppPlan,
  repeats = 1,
) => {
  let appliedReads = 0;
  const timeline: string[] = [];
  const harness = makeHarness({
    plannedApp: desired,
    onApply: () => {
      timeline.push("apply");
    },
    onPublish: (event) =>
      Effect.sync(() => {
        if (event._tag === "message.warn") timeline.push("warn");
      }),
  });
  const target = {
    plan: desired,
    root: desired.root,
    app: { kind: "user" as const, id: desired.id, root: desired.root },
  };
  const operation = () => {
    switch (path) {
      case "start":
        return startApp({}, target);
      case "rebuild":
        return rebuildApp({}, target);
      case "selected rebuild":
        return rebuildApp({ services: [web.name] }, target);
      case "restart":
        return restartApp({}, target);
      case "selected restart":
        return restartApp({ services: [web.name] }, target);
      default: {
        const unreachable: never = path;
        return unreachable;
      }
    }
  };
  try {
    await Effect.runPromise(
      Effect.forEach(Array.from({ length: repeats }), operation).pipe(
        Effect.provideService(RuntimeProviderRegistry, {
          ...harness.runtimeProviderRegistry,
          appliedPlansFor: () => Effect.succeed(previous === undefined ? [] : [previous]),
          resolveAppliedPlan: () =>
            Effect.sync(() => {
              appliedReads++;
              return previous;
            }),
        }),
        Effect.provide(harness.layer),
      ),
    );
    return { warnings: byTag(harness.events, "message.warn"), timeline, appliedReads };
  } finally {
    await rm(harness.userDataRoot, { recursive: true, force: true });
  }
};

for (const path of paths) {
  test.each([
    [
      { state: "unknown", reason: "custom-image" },
      "Service web no longer keeps its home at /home/node: its image now comes from your Landofile.",
    ],
    [
      { state: "unknown", reason: "no-identity" },
      "Service web no longer keeps its home at /home/node: node doesn't declare image users.",
    ],
    [
      { state: "unknown", reason: "undeclared-user", user: "alice" },
      "Service web no longer keeps its home at /home/node: node doesn't know where alice's home is.",
    ],
    [{ ...previousHome, store: "new-home" }, "Service web now keeps its home in a new volume at /home/node."],
    [
      { ...previousHome, target: "/new-home" },
      "Service web now keeps its home in a new volume at /new-home.",
    ],
  ] as const)(`${path} warns once before apply for %j`, async (home, message) => {
    // Given an applied persisted home and changed desired home metadata.
    const previous = withHome(previousHome);
    // When the command applies the desired plan, including any delegated start.
    const { warnings, timeline, appliedReads } = await runTransition(path, previous, withHome(home));
    // Then one warning names the old volume and an exact, parseable reattachment declaration.
    expect(warnings.map((event) => event.body)).toEqual([
      `${message}\nLando leaves lando-test-web-home-node-old untouched. To reattach it, set storage: [{ store: "lando-test-web-home-node-old", target: "/home/node" }] under services.web in your Landofile.`,
    ]);
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
