import { expect, test } from "bun:test";
import { SCRATCH_LABEL } from "@lando/container-runtime/labels";
import { AbsolutePath, AppId, ProviderId, ServiceName } from "@lando/sdk/schema";
import type { ServiceRuntimeInfo } from "@lando/sdk/services";
import { deriveRunningTargets } from "../../src/operations/running-inventory.ts";

test("selects scratch containers with uncertain status and skips terminal containers", () => {
  const providerId = ProviderId.make("lando");
  const services: ServiceRuntimeInfo[] = (["unknown", "removing", "exited", "dead", "absent"] as const).map(
    (status) => ({
      app: AppId.make(`scratch-${status}`),
      appRoot: AbsolutePath.make(`/scratch/${status}`),
      service: ServiceName.make("web"),
      providerId,
      status,
      labels: { [SCRATCH_LABEL]: "TRUE" },
      publications: { status: "unknown" },
    }),
  );
  const result = deriveRunningTargets(
    [{ providerId, runtimeObserved: true, appliedPlans: [], services, volumes: [] }],
    [],
  );
  expect([...result.scratchObserved.keys()]).toEqual(["scratch-unknown", "scratch-removing"]);
  expect([...result.userTargets]).toEqual([]);
  expect(result.failures).toEqual([]);
});
