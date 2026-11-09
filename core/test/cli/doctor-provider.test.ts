import { describe, expect, test } from "bun:test";

import { linuxDockerCapabilities } from "@lando/provider-docker";
import { ProviderUnavailableError } from "@lando/sdk/errors";
import { diagnosePrimaryProvider } from "../../src/cli/commands/doctor-provider.ts";

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
      status: { state: "running", message },
      statusProbe: "failure",
      statusFailure: new ProviderUnavailableError({
        providerId: "docker",
        operation: "getStatus",
        message,
        remediation: "Install a compatible Docker Engine.",
      }),
      runtimeVersion: undefined,
      bundleVersion: undefined,
      selection: {
        providerId: "docker",
        source: "flag",
        inputs: { flag: "docker", capabilityDefault: "lando" },
      },
    });

    expect(diagnosis.check.status).toBe("fail");
    expect(diagnosis.runtimeMessage).toContain("1.43-1.44");
    expect(diagnosis.runtimeMessage).toContain("1.50-1.55");
    expect(diagnosis.check.runtime?.message).toBe(message);
  });
});
