import { expect, test } from "bun:test";
import { ServiceNotReadyError } from "@lando/sdk/errors";
import { Schema } from "effect";

test.each(["not-running", "inspect-failed", "healthcheck-failed", "healthcheck-timeout"] as const)(
  "readiness error round-trips %s and all evidence",
  (reason) => {
    const error = new ServiceNotReadyError({
      message: "Service failed readiness",
      app: "demo",
      service: "web",
      providerId: "lando",
      reason,
      remediation: "Run lando doctor",
      exitCode: 17,
      state: "stopped",
      attempts: 3,
      lastStatus: "process exited",
      logTail: {
        service: "web",
        lines: ["startup failed"],
        truncated: false,
        exitCode: 17,
        timedOut: true,
      },
    });
    const encoded = Schema.encodeSync(ServiceNotReadyError)(error);
    const decoded = Schema.decodeUnknownSync(ServiceNotReadyError)(encoded);
    expect(decoded).toBeInstanceOf(ServiceNotReadyError);
    expect(Schema.encodeSync(ServiceNotReadyError)(decoded)).toEqual(encoded);
    expect(decoded.reason).toBe(reason);
    expect(decoded.logTail?.lines).toEqual(["startup failed"]);
  },
);
