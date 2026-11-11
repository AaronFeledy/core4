import { expect, test } from "bun:test";
import type { BindMountPlan, TmpfsMountPlan, VolumeMountPlan } from "@lando/sdk/schema";
import type { EphemeralRunSpec, RuntimeProviderShape } from "@lando/sdk/services";
import { EphemeralBindMount, EphemeralMountSource } from "@lando/sdk/services";
import { Schema } from "effect";

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

test("borrowed mounts require an explicit container identity and access mode", () => {
  const decode = Schema.decodeUnknownOption(EphemeralMountSource);
  expect(decode({ containerId: "service-container", readOnly: true })._tag).toBe("Some");
  for (const invalid of [
    { containerId: "", readOnly: true },
    { containerId: "container" },
    { readOnly: false },
  ])
    expect(decode(invalid)._tag).toBe("None");
});

test("explicit host binds decode source, target, and optional access mode", () => {
  const decode = Schema.decodeUnknownOption(EphemeralBindMount);
  expect(decode({ source: "/host", target: "/container" })._tag).toBe("Some");
  expect(decode({ source: "/host", target: "/container", readOnly: true })._tag).toBe("Some");
  for (const invalid of [
    { source: "", target: "/container" },
    { source: "/host", target: "" },
    { target: "/container" },
    { source: "/host" },
    { source: "/host", target: "/container", readOnly: "true" },
  ])
    expect(decode(invalid)._tag).toBe("None");
});
