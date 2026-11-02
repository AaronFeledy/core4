import { describe, expect, test } from "bun:test";
import { Schema } from "effect";

import * as SchemaExports from "@lando/sdk/schema";

const runtimeKnobExports = [
  "ComposeBooleanOrStringField",
  "ComposeByteSizeField",
  "ComposeCapAddField",
  "ComposeCapDropField",
  "ComposeDeploy",
  "ComposeDeployField",
  "ComposeDeployResources",
  "ComposeDeploymentDevice",
  "ComposeDevice",
  "ComposeDevicesField",
  "ComposeDiscreteResourceSpec",
  "ComposeDnsField",
  "ComposeDnsOptField",
  "ComposeDnsSearchField",
  "ComposeDurationSecondsField",
  "ComposeExtraHostsField",
  "ComposeGenericResource",
  "ComposeGpuRequest",
  "ComposeGpusField",
  "ComposeGroupAddField",
  "ComposeLogging",
  "ComposePullPolicyField",
  "ComposeResourceLimits",
  "ComposeResourceReservations",
  "ComposeRestartField",
  "ComposeScalarMap",
  "ComposeScalarMapField",
  "ComposeSecurityOptField",
  "ComposeShmSizeField",
  "ComposeStopGracePeriodField",
  "ComposeStringListField",
  "ComposeSysctlsField",
  "ComposeTmpfsField",
  "ComposeUlimit",
  "ComposeUlimitsField",
] as const;

describe("Compose runtime-knob exports", () => {
  test("publishes every promised Compose runtime-knob schema through the public barrel", () => {
    for (const exportName of runtimeKnobExports) {
      expect(Object.hasOwn(SchemaExports, exportName), exportName).toBe(true);
    }
    expect(Schema.decodeUnknownSync(SchemaExports.ComposeRestartField)("always")).toBe("always");
    expect(() => Schema.decodeUnknownSync(SchemaExports.ComposeRestartField)("sometimes")).toThrow();
    expect(Schema.decodeUnknownSync(SchemaExports.ComposeDeployField)({ resources: {} })).toEqual({
      resources: {},
    });
    expect(Object.hasOwn(SchemaExports, "ComposeServiceKnobFields")).toBe(false);
  });

  test("publishes the exact preserved-path capability schemas through the public barrel", () => {
    expect(Object.hasOwn(SchemaExports, "ComposePreservedPathKey")).toBe(true);
    expect(Object.hasOwn(SchemaExports, "ComposePreservedPathCapabilities")).toBe(true);
    expect(
      Schema.decodeUnknownSync(SchemaExports.ComposePreservedPathKey)("healthcheck.start_interval"),
    ).toBe("healthcheck.start_interval");
    expect(() =>
      Schema.decodeUnknownSync(SchemaExports.ComposePreservedPathKey)("healthcheck.start_period"),
    ).toThrow();
    expect(Object.hasOwn(SchemaExports, "ComposeServiceKnobFields")).toBe(false);
  });
});
