import { expect, test } from "bun:test";
import { AbsolutePath, type AppPlan, type MountPlan, PortablePath } from "@lando/sdk/schema";
import { projectFileSyncInfo, projectFileSyncPolicy } from "../../src/operations/info-file-sync.ts";
import { acceleratedPlan } from "./accelerated-start-recovery-support.ts";
import { appMount, plan, runInfo, service, withAppMount } from "./info-storage-fixture.ts";

const ordinary: AppPlan = {
  ...plan,
  services: { [service.name]: withAppMount() },
  fileSyncPolicy: {
    reason: "native-provider",
    services: { web: { mode: "ordinary", reason: "native-provider" } },
  },
};

test("separates planned policy from recorded applied policy without claiming daemon state", () => {
  const result = projectFileSyncInfo(ordinary, acceleratedPlan);
  expect(result).toMatchObject({
    planned: { mode: "ordinary", reason: "native-provider" },
    applied: { mode: "accelerated", engineId: "mutagen", reason: "unknown" },
    pendingChange: true,
  });
});

test("historical reasons and absent applied state remain unknown or absent", () => {
  expect(projectFileSyncPolicy(plan).reason).toBe("unknown");
  expect(projectFileSyncInfo(ordinary, undefined)).not.toHaveProperty("applied");
});

test("reports host-backed includes even when an exact include cancels its overlay", () => {
  expect(projectFileSyncPolicy(ordinary).services[0]?.hostBackedIncludes).toEqual([
    { source: "/host/app/.git", target: "/app/.git" },
  ]);
});

test("projects includes beneath an app mount at the container root", () => {
  const rooted: AppPlan = {
    ...ordinary,
    services: { [service.name]: withAppMount(service, { ...appMount, target: PortablePath.make("/") }) },
  };
  expect(projectFileSyncPolicy(rooted).services[0]?.hostBackedIncludes).toEqual([
    { source: "/host/app/.git", target: "/.git" },
  ]);
});

for (const shadow of [
  {
    type: "volume",
    store: "shadow",
    target: PortablePath.make("/app/.git"),
    readOnly: false,
    origin: "authored",
  },
  { type: "tmpfs", target: PortablePath.make("/app/.git"), readOnly: false },
  {
    type: "bind",
    source: AbsolutePath.make("/other"),
    target: PortablePath.make("/app/.git"),
    readOnly: false,
    realization: "passthrough",
  },
] satisfies readonly MountPlan[]) {
  test(`omits includes hidden by an authored ${shadow.type}`, () => {
    // Given an include hidden by a different effective mount.
    const hidden: AppPlan = {
      ...ordinary,
      services: { [service.name]: { ...withAppMount(), mounts: [appMount, shadow] } },
    };
    // When projecting the policy.
    const result = projectFileSyncPolicy(hidden);
    // Then the include is not presented as host-backed.
    expect(result.services[0]?.hostBackedIncludes).toEqual([]);
  });
  test(`omits nested includes hidden below an authored ${shadow.type}`, () => {
    const hidden: AppPlan = {
      ...ordinary,
      services: {
        [service.name]: {
          ...withAppMount(),
          mounts: [
            { ...appMount, includes: ["vendor/local"] },
            { ...shadow, target: PortablePath.make("/app/vendor") },
          ],
        },
      },
    };
    expect(projectFileSyncPolicy(hidden).services[0]?.hostBackedIncludes).toEqual([]);
  });
}

test("retains an include restored beneath an intervening authored mount", () => {
  // Given a nested include with its own matching bind below a shadow.
  const nested: AppPlan = {
    ...ordinary,
    services: {
      [service.name]: {
        ...withAppMount(),
        mounts: [
          { ...appMount, includes: ["vendor/local"] },
          {
            type: "volume",
            store: "shadow",
            target: PortablePath.make("/app/vendor"),
            readOnly: false,
            origin: "authored",
          },
          {
            type: "bind",
            source: AbsolutePath.make("/host/app/vendor/local"),
            target: PortablePath.make("/app/vendor/local"),
            readOnly: false,
            realization: "passthrough",
          },
        ],
      },
    },
  };
  // When projecting, then only the restored mapping is emitted.
  expect(projectFileSyncPolicy(nested).services[0]?.hostBackedIncludes).toEqual([
    { source: "/host/app/vendor/local", target: "/app/vendor/local" },
  ]);
});

test("unknown realization cannot claim a pending policy change", () => {
  // Given an applied accelerated mount with its required sessions missing.
  const malformed: AppPlan = { ...acceleratedPlan, fileSync: [] };
  // When comparing the snapshots, then unknown evidence is not a pending change.
  expect(projectFileSyncInfo(ordinary, malformed)).toMatchObject({
    applied: { mode: "unknown" },
    pendingChange: false,
  });
  expect(projectFileSyncInfo(malformed, ordinary).pendingChange).toBe(false);
});

test("rejects recorded explanatory metadata that contradicts session and mount facts", () => {
  const misleading: AppPlan = {
    ...ordinary,
    fileSyncPolicy: {
      engineId: "invented",
      reason: "explicit-engine",
      services: { web: { mode: "accelerated", reason: "explicit-engine" } },
    },
  };
  expect(projectFileSyncPolicy(misleading)).toMatchObject({ mode: "ordinary", reason: "unknown" });
  const falseReason: AppPlan = {
    ...ordinary,
    fileSyncPolicy: {
      reason: "explicit-engine",
      services: { web: { mode: "ordinary", reason: "explicit-engine" } },
    },
  };
  expect(projectFileSyncPolicy(falseReason).reason).toBe("unknown");
});

test.each([
  { root: "/app", overlay: "/app/node_modules" },
  { root: "/", overlay: "/node_modules" },
])("distinguishes directory overlays from transport filters at $root", ({ root, overlay }) => {
  const overlaid = {
    ...ordinary,
    services: {
      web: withAppMount(
        {
          ...service,
          mounts: [
            {
              type: "volume" as const,
              store: "dependencies",
              target: PortablePath.make(overlay),
              readOnly: false,
              origin: "derived" as const,
            },
          ],
        },
        { ...appMount, target: PortablePath.make(root) },
      ),
    },
  };
  expect(projectFileSyncPolicy(overlaid).services[0]?.exclusions).toEqual({
    kind: "directory-overlays",
    patterns: [],
    overlays: [overlay],
  });
  expect(projectFileSyncPolicy(acceleratedPlan).services[0]?.exclusions.kind).toBe("transport-patterns");
});

test("does not describe mounted ordinary services as absent app mounts", () => {
  const misleading: AppPlan = {
    ...ordinary,
    fileSyncPolicy: {
      reason: "absent-app-mount",
      services: { web: { mode: "ordinary", reason: "absent-app-mount" } },
    },
  };
  expect(projectFileSyncPolicy(misleading).reason).toBe("unknown");
  expect(projectFileSyncPolicy(misleading).services[0]?.reason).toBe("unknown");
});

test("ordinary info observes the provider without any engine acquisition or probes", async () => {
  const { row, calls } = await runInfo(withAppMount());
  expect(calls).toEqual(["select", "inspect:web"]);
  expect(row?.appMount).toEqual(appMount);
});
