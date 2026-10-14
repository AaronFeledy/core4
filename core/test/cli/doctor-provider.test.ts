import { describe, expect, test } from "bun:test";

import { diagnosePrimaryProvider } from "../../src/cli/commands/doctor-provider.ts";
import { linuxDockerCapabilities } from "@lando/provider-docker";

describe("diagnosePrimaryProvider Docker API versions", () => {
  test("keeps both Lando and daemon API ranges in the selected-provider check", () => {
    const message =
      "Cannot negotiate a Docker Engine API version. Lando supports 1.43-1.44; this daemon reports 1.50-1.55.";
    const diagnosis = diagnosePrimaryProvider({
      provider: {
        id: "docker",
        displayName: "Docker Runtime Provider",
        version: "0.0.0",
        platform: "linux",
        capabilities: linuxDockerCapabilities,
      },
      status: { running: false, message },
      statusProbe: undefined,
      runtimeVersion: undefined,
      bundleVersion: undefined,
      selection: {
        providerId: "docker",
        source: "flag",
        inputs: { flag: "docker", capabilityDefault: "lando" },
      },
    });

    expect(diagnosis.check.status).toBe("warn");
    expect(diagnosis.runtimeMessage).toContain("1.43-1.44");
    expect(diagnosis.runtimeMessage).toContain("1.50-1.55");
    expect(diagnosis.check.runtime?.message).toBe(message);
  });
});
