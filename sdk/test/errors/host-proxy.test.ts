import { describe, expect, test } from "bun:test";

import {
  HostProxyAllowlistConflictError,
  HostProxyAuthenticationError,
  HostProxyBackpressureError,
  HostProxyCommandNotAllowedError,
  HostProxyRecursionError,
  HostProxySocketStaleError,
  HostProxyTransportUnavailableError,
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

describe("host-proxy transport errors", () => {
  test("auth failures carry tag, reason, and remediation", () => {
    const error = new HostProxyAuthenticationError({
      message: "token missing",
      reason: "missing",
      remediation: "Restart the app.",
    });

    expect(error._tag).toBe("HostProxyAuthenticationError");
    expect(error.reason).toBe("missing");
    expect(error.remediation).toContain("Restart");
  });

  test("recursion failures carry depth", () => {
    const error = new HostProxyRecursionError({
      message: "nested runLando",
      depth: 1,
      remediation: "Run on the host.",
    });

    expect(error._tag).toBe("HostProxyRecursionError");
    expect(error.depth).toBe(1);
  });

  test("backpressure failures carry concurrency", () => {
    const error = new HostProxyBackpressureError({
      message: "saturated",
      concurrency: 4,
      remediation: "Retry later.",
    });

    expect(error._tag).toBe("HostProxyBackpressureError");
    expect(error.concurrency).toBe(4);
  });

  test("transport unavailable failures carry socket path", () => {
    const error = new HostProxyTransportUnavailableError({
      message: "socket missing",
      socketPath: "/tmp/runlando.sock",
      remediation: "Start the app.",
    });

    expect(error._tag).toBe("HostProxyTransportUnavailableError");
    expect(error.socketPath).toBe("/tmp/runlando.sock");
  });

  test("stale socket failures carry socket path", () => {
    const error = new HostProxySocketStaleError({
      message: "socket already exists",
      socketPath: "/tmp/host-proxy.sock",
      remediation: "Refresh app cache.",
    });

    expect(error._tag).toBe("HostProxySocketStaleError");
    expect(error.socketPath).toBe("/tmp/host-proxy.sock");
  });
});
