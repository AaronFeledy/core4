import { describe, expect, test } from "bun:test";
import { Schema } from "effect";

import { AbsolutePath, PortablePath, ProviderId, ServiceName, ServicePlan } from "@lando/sdk/schema";

import { decodeServicePlan } from "../../src/services/_schema-helpers.ts";

const validPlanInput = {
  name: ServiceName.make("web"),
  type: "apache",
  provider: ProviderId.make("lando"),
  primary: true,
  artifact: { kind: "ref", ref: "httpd:2.4-alpine" },
  environment: {},
  workingDirectory: PortablePath.make("/app"),
  appMount: {
    source: AbsolutePath.make("/srv/app"),
    target: PortablePath.make("/app"),
    readOnly: false,
    excludes: [],
    includes: [],
    realization: "passthrough",
  },
  mounts: [],
  storage: [],
  endpoints: [{ port: 80, protocol: "http", name: "web" }],
  routes: [],
  dependsOn: [],
  hostAliases: [],
  metadata: {
    resolvedAt: "2026-05-18T08:00:00Z",
    source: "/srv/app/.lando.yml",
    runtime: 4,
  },
  extensions: {},
};

const thrownShape = (use: () => unknown) => {
  try {
    use();
  } catch (error) {
    return {
      name: error instanceof Error ? error.name : undefined,
      message: error instanceof Error ? error.message : String(error),
      string: String(error),
    };
  }
  throw new Error("Expected decoder to throw.");
};

describe("service schema helpers", () => {
  test("decodeServicePlan returns the raw ServicePlan decoder output", () => {
    expect(decodeServicePlan(validPlanInput)).toEqual(Schema.decodeUnknownSync(ServicePlan)(validPlanInput));
  });

  test("decodeServicePlan throws the same malformed-plan error shape as the raw decoder", () => {
    const malformedPlanInput = {
      ...validPlanInput,
      endpoints: [{ port: "eighty", protocol: "http", name: "web" }],
    };

    expect(thrownShape(() => decodeServicePlan(malformedPlanInput))).toEqual(
      thrownShape(() => Schema.decodeUnknownSync(ServicePlan)(malformedPlanInput)),
    );
  });
});
