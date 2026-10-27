import { expect, test } from "bun:test";
import type { BindMountPlan, TmpfsMountPlan, VolumeMountPlan } from "@lando/sdk/schema";
import type { EphemeralRunSpec, RuntimeProviderShape } from "@lando/sdk/services";

type RunMount = NonNullable<EphemeralRunSpec["mounts"]>[number];
type StreamMount = NonNullable<Parameters<RuntimeProviderShape["runStream"]>[0]["mounts"]>[number];
const assertType = <T extends true>(value: T): T => value;

test("ephemeral run and runStream accept only volume mounts", () => {
  assertType<VolumeMountPlan extends RunMount ? true : false>(true);
  assertType<RunMount extends VolumeMountPlan ? true : false>(true);
  assertType<BindMountPlan extends RunMount ? false : true>(true);
  assertType<TmpfsMountPlan extends RunMount ? false : true>(true);
  assertType<StreamMount extends VolumeMountPlan ? true : false>(true);
  expect(assertType<VolumeMountPlan extends StreamMount ? true : false>(true)).toBe(true);
});
