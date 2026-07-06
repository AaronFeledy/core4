import { describe, expect, test } from "bun:test";

import {
  HostProxyAllowlistConflictError,
  HostProxyCommandNotAllowedError,
} from "../../src/errors/host-proxy.ts";

describe("HostProxyCommandNotAllowedError", () => {
  test("carries tag, command id, allowlist, and remediation", () => {
    const error = new HostProxyCommandNotAllowedError({
      message: "app:destroy is not on the host-proxy allowlist.",
      commandId: "app:destroy",
      effectiveAllowlist: ["app:open"],
      remediation: "Only host-proxy-allowed commands may be forwarded.",
    });
    expect(error._tag).toBe("HostProxyCommandNotAllowedError");
    expect(error.commandId).toBe("app:destroy");
    expect(error.effectiveAllowlist).toEqual(["app:open"]);
    expect(error.remediation).toContain("host-proxy");
  });
});

describe("HostProxyAllowlistConflictError", () => {
  test("carries tag, command id, and remediation", () => {
    const error = new HostProxyAllowlistConflictError({
      message: "app:start must not set hostProxyAllowed: true.",
      commandId: "app:start",
      remediation: "Remove hostProxyAllowed from this lifecycle command.",
    });
    expect(error._tag).toBe("HostProxyAllowlistConflictError");
    expect(error.commandId).toBe("app:start");
    expect(error.remediation).toContain("Remove");
  });
});
