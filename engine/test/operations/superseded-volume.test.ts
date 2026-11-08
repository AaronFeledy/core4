import { expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { AppId, type AppPlan, PortablePath, appIdentityKey } from "@lando/sdk/schema";
import { Effect } from "effect";
import { rebuildApp } from "../../src/operations/rebuild.ts";
import { restartApp } from "../../src/operations/restart.ts";
import { startApp } from "../../src/operations/start.ts";
import { byTag, makeHarness, plan, web } from "./start-progress-topology-support.ts";

test.each(
  [startApp, restartApp, rebuildApp].flatMap((operation) =>
    [1, 2].flatMap((count) => [false, true].map((withCurrent) => ({ operation, count, withCurrent }))),
  ),
)(
  "$operation names previous home and data volumes once after retiring $count previous names (current applied: $withCurrent)",
  async ({ operation, count, withCurrent }) => {
    const old: AppPlan = {
      ...plan,
      id: AppId.make("previous"),
      name: "previous",
      identity: { appRoot: plan.root, ownerKey: appIdentityKey("owner", plan.root) },
      services: {
        [web.name]: {
          ...web,
          home: { state: "persisted", target: "/home/node", store: "previous-home", user: "node" },
          mounts: [
            {
              type: "volume",
              origin: "service",
              target: PortablePath.make("/data"),
              store: "previous-data",
              readOnly: false,
            },
          ],
        },
      },
      stores: [
        { name: "previous-home", kind: "data", scope: "service" },
        { name: "previous-data", kind: "data", scope: "service" },
      ],
    };
    const desired: AppPlan = {
      ...old,
      id: AppId.make("renamed"),
      name: "renamed",
      services: {
        [web.name]: {
          ...web,
          home: { state: "persisted", target: "/home/node", store: "new-home", user: "node" },
          mounts: [
            {
              type: "volume",
              origin: "service",
              target: PortablePath.make("/data"),
              store: "new-data",
              readOnly: false,
            },
          ],
        },
      },
      stores: [
        { name: "new-home", kind: "data", scope: "service" },
        { name: "new-data", kind: "data", scope: "service" },
      ],
    };
    const applied = [
      ...Array.from({ length: count }, (_, index) => ({ ...old, id: AppId.make(`previous-${index}`) })),
      ...(withCurrent ? [desired] : []),
    ];
    const harness = makeHarness({
      plannedApp: desired,
      appliedPlans: applied,
      resolveAppliedPlan: () => Effect.sync(() => applied.find((plan) => plan.id === desired.id)),
      onDestroy: (ref, options) => {
        const index = applied.findIndex((plan) => plan.id === ref.app);
        if (index >= 0 && options?.removeState === true) applied.splice(index, 1);
      },
      onApply: (plan) => {
        applied.splice(0, applied.length, plan);
      },
    });
    try {
      await Effect.runPromise(
        operation(
          {},
          { plan: desired, root: desired.root, app: { kind: "user", id: desired.id, root: desired.root } },
        ).pipe(Effect.provide(harness.layer)),
      );
      const notices = byTag(harness.events, "message.warn").filter(
        (event) => event.body.includes("previous-home") && event.body.includes("new-home"),
      );
      expect(notices).toHaveLength(1);
      expect(notices[0]?.body).toContain('storage: [{ store: "previous-home", target: "/home/node" }]');
      const dataNotices = byTag(harness.events, "message.warn").filter(
        (event) => event.body.includes("previous-data") && event.body.includes("new-data"),
      );
      expect(dataNotices).toHaveLength(1);
      expect(dataNotices[0]?.body).toContain('storage: [{ store: "previous-data", target: "/data" }]');
      expect(applied.map((plan) => plan.id)).toEqual([desired.id]);
    } finally {
      rmSync(harness.userDataRoot, { recursive: true, force: true });
    }
  },
);
