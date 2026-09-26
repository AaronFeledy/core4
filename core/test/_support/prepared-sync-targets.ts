import { AbsoluteContainerPath, type AppPlan, type PreparedFileSyncTarget } from "@lando/core/schema";

/** Exact mock endpoints for tests that deliberately opt into accelerated mounts. */
export const preparedFileSyncTargets = (plan: AppPlan): ReadonlyArray<PreparedFileSyncTarget> =>
  plan.fileSync.map(({ session }, index) => {
    if (session.target._tag !== "volume") {
      throw new Error("Accelerated test sessions require a named volume target.");
    }
    return {
      session,
      endpoint: {
        _tag: "container",
        containerId: ["test-sync-helper", index].join("-"),
        path: AbsoluteContainerPath.make("/sync"),
        volumeName: session.target.name,
      },
    };
  });
